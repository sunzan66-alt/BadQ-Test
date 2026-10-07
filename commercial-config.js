// BadQ Web Sync Phase 1 — Commercial TEST Identity Bridge configuration.
//
// This checked-in file is intentionally disabled and contains no credential. For an approved
// local TEST acceptance run, copy the public Firebase Web App values from badq-commercial-test
// into a disposable build copy and set enabled=true. Never point this adapter at PROD.
window.BadQCommercialConfig = Object.freeze({
  enabled: false,
  environment: "TEST",
  apiBaseUrl: "https://api-xommxsjila-as.a.run.app",
  firebase: Object.freeze({
    apiKey: "",
    authDomain: "",
    projectId: "badq-commercial-test",
    appId: "",
  }),
});
