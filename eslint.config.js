import tseslint from "typescript-eslint";
export default tseslint.config({ ignores: ["build/**", "dist/**", "node_modules/**"] }, ...tseslint.configs.recommended, { rules: { "@typescript-eslint/no-empty-function": "off" } });
