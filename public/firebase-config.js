// Firebase web-app config — public by design (security comes from Firestore
// rules, not from hiding these values). This committed copy is a
// placeholder: the real value is generated at deploy time by
// scripts/gen-web-config.mjs from the FIREBASE_WEB_CONFIG secret, and for
// local dev from web-config.local.json. See README for setup.
export const firebaseConfig = {
    apiKey: "REPLACE_ME",
    authDomain: "screeps-52c72.firebaseapp.com",
    projectId: "screeps-52c72",
};
