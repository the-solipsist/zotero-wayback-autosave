import js from "@eslint/js";

export default [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: {
        Zotero: "readonly",
        Services: "readonly",
        // Firefox/Zotero chrome context + prefs.js legacy hook
        pref: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        URL: "readonly",
      },
    },
    rules: {
      "no-unused-vars": ["error", { args: "none", caughtErrors: "none" }],
      eqeqeq: ["error", "smart"],
    },
  },
  {
    ignores: ["wayback-autosave.xpi"],
  },
];
