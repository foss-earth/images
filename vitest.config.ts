import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["src/**/*.test.ts", "tests/**/*.test.ts"], forceRerunTriggers: ["fixtures/**", "tests/**", "package.json", "tsconfig.json", "node/**"] } });
