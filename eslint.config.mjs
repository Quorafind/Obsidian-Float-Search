// @ts-check
import { defineConfig, globalIgnores } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
	// Build output and Node build scripts are not plugin code.
	globalIgnores([
		"node_modules",
		"main.js",
		"esbuild.config.mjs",
		"version-bump.mjs",
		"eslint.config.mjs",
	]),
	...obsidianmd.configs.recommended,
	{
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
	},
	{
		// The community directory scanner checks newer submissions with these
		// rules as errors; keep them strict locally so a release can't regress.
		files: ["**/*.ts"],
		rules: {
			"obsidianmd/settings-tab/no-manual-html-headings": "error",
			"obsidianmd/settings-tab/no-problematic-settings-headings": "error",
			"obsidianmd/sample-names": "error",
			"obsidianmd/no-sample-code": "error",
			"obsidianmd/platform": "error",
			"obsidianmd/no-plugin-as-component": "error",
			"obsidianmd/detach-leaves": "error",
			"obsidianmd/no-static-styles-assignment": "error",
			"obsidianmd/no-view-references-in-plugin": "error",
			"obsidianmd/no-unsupported-api": "error",
		},
	},
]);
