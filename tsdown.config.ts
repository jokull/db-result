import { defineConfig } from "tsdown";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/drivers/pg.ts",
    "src/drivers/sqlite.ts",
    "src/drivers/d1.ts",
    "src/drivers/mysql2.ts",
    "src/drivers/mssql.ts",
  ],
  format: ["esm"],
  dts: {
    resolve: true,
  },
  clean: true,
  sourcemap: true,
  minify: true,
  // Package validation, run after every build (local — no CI needed):
  publint: { level: "error" }, // exports/main/module/types vs actual files
  attw: { enabled: true, profile: "esm-only", level: "error" }, // type-resolution interop
});
