import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["src/**/*.test.ts", "tests/**/*.test.ts"], forceRerunTriggers: ["fixtures/**", "package.json", "tsconfig.json", "node/**"] } });
