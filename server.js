const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const vm = require("node:vm");
const { DatabaseSync } = require("node:sqlite");

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || "0.0.0.0";
const SESSION_MAX_AGE = 12 * 60 * 60 * 1000;
const COOKIE_NAME = "ema_cms_session";
fs.mkdirSync(DATA_DIR, { recursive: true });
const database = new DatabaseSync(path.join(DATA_DIR, "site-content.sqlite"));
const sessions = new Map();
const loginAttempts = new Map();
const publicFiles = new Map([
    ["/", ["index.html", "text/html; charset=utf-8"]],
    ["/index.html", ["index.html", "text/html; charset=utf-8"]],
    ["/dashboard", ["dashboard.html", "text/html; charset=utf-8"]],
    ["/dashboard.html", ["dashboard.html", "text/html; charset=utf-8"]],
    ["/site-content.js", ["site-content.js", "text/javascript; charset=utf-8"]],
    ["/cms-client.js", ["cms-client.js", "text/javascript; charset=utf-8"]],
    ["/Logo%20without%20BG.png", ["Logo without BG.png", "image/png"]],
    ["/Logo without BG.png", ["Logo without BG.png", "image/png"]],
    ["/Logo%20with%20white.jpg", ["Logo with white.jpg", "image/jpeg"]],
    ["/Logo with white.jpg", ["Logo with white.jpg", "image/jpeg"]]
]);

database.exec(`
    pragma journal_mode = WAL;
    create table if not exists site_content (
        id text primary key check (id = 'main'),
        content text not null,
        updated_at text not null
    );
    create table if not exists cms_admin (
        id integer primary key check (id = 1),
        email text not null unique,
        salt text not null,
        password_hash text not null
    );
`);

function loadDefaults() {
    const source = fs.readFileSync(path.join(ROOT, "site-content.js"), "utf8");
    const context = { window: {} };
    vm.runInNewContext(source, context, { timeout: 1000 });
    return context.window.SITE_DEFAULT_CONTENT;
}

const seed = database.prepare("insert or ignore into site_content (id, content, updated_at) values ('main', ?, ?)");
seed.run(JSON.stringify(loadDefaults()), new Date().toISOString());

function hashPassword(password, salt) {
    return crypto.scryptSync(password, salt, 64);
}

function setupAdmin() {
    const existing = database.prepare("select email from cms_admin where id = 1").get();
    if (existing) return;

    const email = process.env.CMS_ADMIN_EMAIL || "admin@localhost";
    const password = process.env.CMS_ADMIN_PASSWORD || crypto.randomBytes(18).toString("base64url");
    const salt = crypto.randomBytes(16).toString("hex");
    database.prepare("insert into cms_admin (id, email, salt, password_hash) values (1, ?, ?, ?)")
        .run(email.toLowerCase(), salt, hashPassword(password, salt).toString("hex"));

    console.log("\nEMA SOFT CMS first-run administrator");
    console.log(`Email: ${email.toLowerCase()}`);
    if (process.env.CMS_ADMIN_PASSWORD) {
        console.log("Password: loaded from CMS_ADMIN_PASSWORD");
    } else {
        console.log(`Temporary password: ${password}`);
    }
    console.log("Save these credentials. The password is not stored in plain text and will not be shown again.\n");
}

setupAdmin();

function sendJson(response, status, data, extraHeaders = {}) {
    response.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "same-origin",
        ...extraHeaders
    });
    response.end(data === null ? "" : JSON.stringify(data));
}

function parseCookies(request) {
    const cookieHeader = request.headers.cookie || "";
    return Object.fromEntries(cookieHeader.split(";").map(cookie => {
        const separator = cookie.indexOf("=");
        return separator < 0
            ? ["", ""]
            : [cookie.slice(0, separator).trim(), decodeURIComponent(cookie.slice(separator + 1).trim())];
    }));
}

function authenticatedSession(request) {
    const token = parseCookies(request)[COOKIE_NAME];
    const expiresAt = token ? sessions.get(token) : null;
    if (!expiresAt) return null;
    if (expiresAt <= Date.now()) {
        sessions.delete(token);
        return null;
    }
    return token;
}

function readJson(request, maxLength = 1_000_000) {
    return new Promise((resolve, reject) => {
        let body = "";
        request.on("data", chunk => {
            body += chunk;
            if (Buffer.byteLength(body) > maxLength) {
                reject(new Error("Request body is too large."));
                request.destroy();
            }
        });
        request.on("end", () => {
            try {
                resolve(JSON.parse(body || "{}"));
            } catch {
                reject(new Error("Request body must be valid JSON."));
            }
        });
        request.on("error", reject);
    });
}

function cleanText(value, field, maxLength = 10000) {
    if (typeof value !== "string" || value.length > maxLength) {
        throw new Error(`${field} must be text shorter than ${maxLength} characters.`);
    }
    return value;
}

function localizedText(value, field, maxLength = 10000) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${field} must have English and Arabic values.`);
    }
    return {
        en: cleanText(value.en, `${field} (English)`, maxLength),
        ar: cleanText(value.ar, `${field} (Arabic)`, maxLength)
    };
}

function validateContent(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new Error("Content must be a JSON object.");
    }
    const translations = {};
    for (const language of ["en", "ar"]) {
        const source = input.translations && input.translations[language];
        if (!source || typeof source !== "object" || Array.isArray(source)) {
            throw new Error(`Missing ${language} translations.`);
        }
        translations[language] = {};
        for (const [key, value] of Object.entries(source)) {
            if (!/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(key)) {
                throw new Error("A translation key is invalid.");
            }
            translations[language][key] = cleanText(value, `Translation ${key}`);
        }
    }
    if (!Array.isArray(input.services) || input.services.length > 100) {
        throw new Error("Services must be an array of at most 100 items.");
    }
    if (!Array.isArray(input.projects) || input.projects.length > 100) {
        throw new Error("Projects must be an array of at most 100 items.");
    }
    const validateIds = items => {
        const ids = new Set();
        return items.map(item => {
            if (!item || typeof item !== "object" || typeof item.id !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(item.id) || ids.has(item.id)) {
                throw new Error("Every service and project must have a unique valid ID.");
            }
            ids.add(item.id);
            return item;
        });
    };
    const services = validateIds(input.services).map(service => ({
        id: service.id,
        icon: cleanText(service.icon, "Service icon", 40),
        title: localizedText(service.title, "Service title", 300),
        description: localizedText(service.description, "Service description", 3000)
    }));
    const projects = validateIds(input.projects).map(project => ({
        id: project.id,
        title: localizedText(project.title, "Project title", 300),
        tag: localizedText(project.tag, "Project category", 300)
    }));
    if (!input.contact || typeof input.contact !== "object") {
        throw new Error("Contact details are required.");
    }
    const email = cleanText(input.contact.email, "Email", 254).trim();
    const whatsapp = cleanText(input.contact.whatsapp, "WhatsApp number", 20).replace(/[\s()+-]/g, "");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw new Error("Enter a valid contact email address.");
    }
    if (!/^\d{8,15}$/.test(whatsapp)) {
        throw new Error("WhatsApp number must contain 8 to 15 digits including the country code.");
    }
    return { translations, services, projects, contact: { email, whatsapp } };
}

function publicContent() {
    const row = database.prepare("select content from site_content where id = 'main'").get();
    if (!row) throw new Error("The site content row does not exist.");
    return JSON.parse(row.content);
}

function isSecureRequest(request) {
    return Boolean(request.socket.encrypted || request.headers["x-forwarded-proto"] === "https");
}

async function handleApi(request, response, pathname) {
    if (request.method === "GET" && pathname === "/api/health") {
        return sendJson(response, 200, { ok: true, database: "sqlite" });
    }
    if (request.method === "GET" && pathname === "/api/content") {
        return sendJson(response, 200, publicContent());
    }
    if (request.method === "POST" && pathname === "/api/login") {
        const ip = request.socket.remoteAddress || "unknown";
        const attempts = loginAttempts.get(ip);
        if (attempts && attempts.count >= 8 && Date.now() - attempts.startedAt < 15 * 60 * 1000) {
            return sendJson(response, 429, { error: "Too many login attempts. Wait 15 minutes and try again." });
        }
        const credentials = await readJson(request, 10000);
        const admin = database.prepare("select email, salt, password_hash from cms_admin where id = 1").get();
        const email = typeof credentials.email === "string" ? credentials.email.toLowerCase().trim() : "";
        const password = typeof credentials.password === "string" ? credentials.password : "";
        const candidate = hashPassword(password, admin.salt);
        const expected = Buffer.from(admin.password_hash, "hex");
        if (email !== admin.email || candidate.length !== expected.length || !crypto.timingSafeEqual(candidate, expected)) {
            const previous = loginAttempts.get(ip);
            loginAttempts.set(ip, previous && Date.now() - previous.startedAt < 15 * 60 * 1000
                ? { ...previous, count: previous.count + 1 }
                : { count: 1, startedAt: Date.now() });
            return sendJson(response, 401, { error: "البريد الإلكتروني أو كلمة المرور غير صحيحة." });
        }
        loginAttempts.delete(ip);
        const token = crypto.randomBytes(32).toString("base64url");
        const expiresAt = Date.now() + SESSION_MAX_AGE;
        sessions.set(token, expiresAt);
        const secure = isSecureRequest(request) ? "; Secure" : "";
        return sendJson(response, 200, { expiresAt }, {
            "Set-Cookie": `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/api; Max-Age=${SESSION_MAX_AGE / 1000}${secure}`
        });
    }
    if (request.method === "GET" && pathname === "/api/admin/session") {
        return sendJson(response, 200, { authenticated: Boolean(authenticatedSession(request)) });
    }
    if (request.method === "PUT" && pathname === "/api/admin/password") {
        const token = authenticatedSession(request);
        if (!token) {
            return sendJson(response, 401, { error: "سجّل الدخول أولاً." });
        }
        const passwords = await readJson(request, 10000);
        const currentPassword = typeof passwords.currentPassword === "string" ? passwords.currentPassword : "";
        const newPassword = typeof passwords.newPassword === "string" ? passwords.newPassword : "";
        if (newPassword.length < 12 || newPassword.length > 1024) {
            return sendJson(response, 400, { error: "كلمة المرور الجديدة يجب أن تحتوي على 12 حرفًا على الأقل." });
        }
        const admin = database.prepare("select email, salt, password_hash from cms_admin where id = 1").get();
        const candidate = hashPassword(currentPassword, admin.salt);
        const expected = Buffer.from(admin.password_hash, "hex");
        if (candidate.length !== expected.length || !crypto.timingSafeEqual(candidate, expected)) {
            return sendJson(response, 403, { error: "كلمة المرور الحالية غير صحيحة." });
        }
        const salt = crypto.randomBytes(16).toString("hex");
        database.prepare("update cms_admin set salt = ?, password_hash = ? where id = 1")
            .run(salt, hashPassword(newPassword, salt).toString("hex"));
        for (const sessionToken of sessions.keys()) {
            if (sessionToken !== token) sessions.delete(sessionToken);
        }
        return sendJson(response, 200, { ok: true });
    }
    if (request.method === "POST" && pathname === "/api/logout") {
        const token = parseCookies(request)[COOKIE_NAME];
        if (token) sessions.delete(token);
        return sendJson(response, 200, { ok: true }, {
            "Set-Cookie": `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/api; Max-Age=0${isSecureRequest(request) ? "; Secure" : ""}`
        });
    }
    if (request.method === "PUT" && pathname === "/api/admin/content") {
        if (!authenticatedSession(request)) {
            return sendJson(response, 401, { error: "سجّل الدخول أولاً." });
        }
        const content = validateContent(await readJson(request));
        database.prepare("update site_content set content = ?, updated_at = ? where id = 'main'")
            .run(JSON.stringify(content), new Date().toISOString());
        return sendJson(response, 200, { ok: true, updatedAt: database.prepare("select updated_at from site_content where id = 'main'").get().updated_at });
    }
    return sendJson(response, 404, { error: "API route not found." });
}

function serveStatic(response, pathname) {
    const entry = publicFiles.get(pathname);
    if (!entry) {
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff" });
        response.end("Not found");
        return;
    }
    const [filename, contentType] = entry;
    const filePath = path.join(ROOT, filename);
    fs.readFile(filePath, (error, contents) => {
        if (error) {
            response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
            response.end("Could not read site file.");
            return;
        }
        response.writeHead(200, {
            "Content-Type": contentType,
            "Cache-Control": contentType.startsWith("image/") ? "public, max-age=3600" : "no-store",
            "X-Content-Type-Options": "nosniff",
            "X-Frame-Options": "DENY",
            "Referrer-Policy": "strict-origin-when-cross-origin"
        });
        response.end(contents);
    });
}

const server = http.createServer(async (request, response) => {
    try {
        const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
        if (url.pathname.startsWith("/api/")) {
            await handleApi(request, response, url.pathname);
            return;
        }
        if (request.method !== "GET" && request.method !== "HEAD") {
            response.writeHead(405, { Allow: "GET, HEAD" });
            response.end();
            return;
        }
        if (request.method === "HEAD") {
            const entry = publicFiles.get(decodeURI(url.pathname));
            if (!entry) {
                response.writeHead(404);
                response.end();
                return;
            }
            response.writeHead(200, { "Content-Type": entry[1], "X-Content-Type-Options": "nosniff" });
            response.end();
            return;
        }
        serveStatic(response, decodeURI(url.pathname));
    } catch (error) {
        console.error("Request failed:", error.message);
        if (!response.headersSent) {
            sendJson(response, 400, { error: error.message || "Request failed." });
        } else {
            response.destroy();
        }
    }
});

server.listen(PORT, HOST, () => {
    console.log(`EMA SOFT CMS running at http://localhost:${PORT}`);
    console.log("Public site: /   |   Admin dashboard: /dashboard");
});

function shutdown() {
    server.close(() => {
        database.close();
        process.exit(0);
    });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
