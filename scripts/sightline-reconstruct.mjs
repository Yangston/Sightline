import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";

const forwarded = process.argv
  .slice(2)
  .map((argument) =>
    argument.startsWith("--ids=")
      ? argument.replace("--ids=", "--calibrate-ids=")
      : argument,
  );
if (!forwarded.some((argument) => argument.startsWith("--server-url=")))
  forwarded.push("--spawn-server");

const child = spawn(
  process.execPath,
  [path.join("scripts", "photography", "calibrate-map.mjs"), ...forwarded],
  { cwd: process.cwd(), env: process.env, stdio: "inherit", windowsHide: true },
);
child.on("exit", (code) => process.exit(code ?? 1));
