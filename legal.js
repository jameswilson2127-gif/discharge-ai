// Fills operator / contact details into the Terms and Privacy pages from config.js.
import { CONFIG } from "./config.js?v=7";

const op = CONFIG.OPERATOR_NAME?.trim() || "the operator of Discharge AI";
const mail = CONFIG.CONTACT_EMAIL || "";
const courts = CONFIG.JURISDICTION_CITY?.trim() ? `the courts at ${CONFIG.JURISDICTION_CITY.trim()}, India` : "the competent courts in India";

document.querySelectorAll("[data-op]").forEach((el) => (el.textContent = op));
document.querySelectorAll("[data-app]").forEach((el) => (el.textContent = CONFIG.APP_NAME || "Discharge AI"));
document.querySelectorAll("[data-updated]").forEach((el) => (el.textContent = CONFIG.TERMS_UPDATED || ""));
document.querySelectorAll("[data-courts]").forEach((el) => (el.textContent = courts));
document.querySelectorAll("[data-ttl]").forEach((el) => (el.textContent = String(CONFIG.CASE_TTL_MINUTES || 120)));
document.querySelectorAll("[data-mail]").forEach((el) => { el.textContent = mail; el.href = `mailto:${mail}`; });
document.querySelectorAll("[data-yr]").forEach((el) => (el.textContent = new Date().getFullYear()));
