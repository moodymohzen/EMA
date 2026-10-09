window.SiteCMS = (() => {
    const storageKey = "ema-site-content-v1";
    const localSessionKey = "ema-cms-local-session";
    let mode = "server";

    async function request(path, options = {}) {
        const response = await fetch(path, {
            method: options.method || "GET",
            credentials: "same-origin",
            headers: options.body === undefined ? {} : { "Content-Type": "application/json" },
            body: options.body === undefined ? undefined : JSON.stringify(options.body)
        });
        if (!response.ok) {
            const responseText = await response.text();
            const error = new Error(`CMS request failed (${response.status}): ${responseText || response.statusText}`);
            error.status = response.status;
            throw error;
        }
        if (response.status === 204) return null;
        return response.json();
    }

    async function readContent() {
        if (mode === "local") {
            const savedContent = localStorage.getItem(storageKey);
            return savedContent ? JSON.parse(savedContent) : null;
        }
        return request("/api/content");
    }

    async function saveContent(content) {
        if (mode === "local") {
            localStorage.setItem(storageKey, JSON.stringify(content));
            return { ok: true, localOnly: true };
        }
        return request("/api/admin/content", { method: "PUT", body: content });
    }

    async function changePassword(currentPassword, newPassword) {
        if (mode === "local") {
            throw new Error("تغيير كلمة المرور غير متاح على الاستضافة الثابتة.");
        }
        return request("/api/admin/password", {
            method: "PUT",
            body: { currentPassword, newPassword }
        });
    }

    async function signIn(email, password) {
        if (mode === "local") {
            return startLocalSession();
        }
        return request("/api/login", { method: "POST", body: { email, password } });
    }

    async function signOut() {
        if (mode === "local") {
            sessionStorage.removeItem(localSessionKey);
            return { ok: true };
        }
        return request("/api/logout", { method: "POST" });
    }

    async function hasSession() {
        if (mode === "local") {
            return sessionStorage.getItem(localSessionKey) === "1";
        }
        const result = await request("/api/admin/session");
        return result.authenticated === true;
    }

    function startLocalSession() {
        mode = "local";
        sessionStorage.setItem(localSessionKey, "1");
        return { localMode: true };
    }

    function isLocalMode() {
        return mode === "local";
    }

    async function health() {
        try {
            const result = await request("/api/health");
            mode = "server";
            return result;
        } catch (error) {
            if (error.status === 404 || window.location.protocol === "file:") {
                mode = "local";
                return { ok: false, localMode: true, error: error.message };
            }
            throw error;
        }
    }

    return { readContent, saveContent, changePassword, signIn, signOut, hasSession, health, startLocalSession, isLocalMode };
})();
