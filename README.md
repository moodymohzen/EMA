# EMA SOFT website and content dashboard

## GitHub Pages / static hosting

Open `dashboard.html` on the same site and choose **فتح لوحة التعديل على هذا الجهاز**. Content edits are saved to that browser's local storage, so the public page reflects them in that browser only. Other visitors and devices continue to see the published defaults. Static hosting cannot provide shared database storage or secure administrator authentication.

## Optional shared database server

To share edits with all visitors, run the included Node.js server on a host with persistent disk storage. Node.js 22.13 or newer is required; no npm packages or manual database creation are needed.

1. Run `start-server.bat`.
2. On the first run, save the administrator email and one-time password shown in the console.
3. Open `http://localhost:4173` and `http://localhost:4173/dashboard`.
4. Change the generated password from **أمان الحساب**.

The server automatically creates `data/site-content.sqlite`, which stores the shared content and a password hash. Back up this file. It is excluded from Git and is not served by the included Node server.

For public deployment, the host must run `node server.js`, preserve the `data` directory across restarts, and serve the site over HTTPS. Set `CMS_ADMIN_EMAIL` and a strong `CMS_ADMIN_PASSWORD` before the first startup if preferred. Existing administrator credentials are initialized once and are not overwritten by later environment changes.
