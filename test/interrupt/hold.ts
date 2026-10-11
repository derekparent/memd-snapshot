// Shared body of the two interrupt fixtures: start one child, say who is alive,
// keep writing under the run's temp root, and hold for a minute.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export async function hold(name: string): Promise<void> {
  const report = process.env.MEMD_INTERRUPT_REPORT;
  if (!report) throw new Error("run this through test/interrupt/run.sh");
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "hold-"));
  fs.writeFileSync(path.join(report, `${name}.pids`), `worker ${process.pid}\nchild ${child.pid}\nroot ${os.tmpdir()}\n`);
  for (let i = 0; i < 600; i++) {
    fs.writeFileSync(path.join(scratch, `tick-${i % 10}`), String(i));
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill();
}
