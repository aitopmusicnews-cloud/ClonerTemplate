import { spawn } from "node:child_process";

export type ProcessResult = { exitCode: number; output: string; truncated: boolean };
const OUTPUT_LIMIT = 24_000;

function childEnvironment(): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {
    NODE_ENV: "production",
    CI: "true",
    NEXT_TELEMETRY_DISABLED: "1",
  };
  for (const name of ["PATH", "TMPDIR", "TMP", "TEMP"]) {
    if (process.env[name] !== undefined) result[name] = process.env[name];
  }
  return result;
}

export async function runProcess(options: {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  allowedExitCodes?: number[];
}): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: childEnvironment(),
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let truncated = false;
    let settled = false;

    const append = (chunk: Buffer) => {
      if (output.length >= OUTPUT_LIMIT) {
        truncated = true;
        return;
      }
      const text = chunk.toString("utf8");
      const remaining = OUTPUT_LIMIT - output.length;
      output += text.slice(0, remaining);
      if (text.length > remaining) truncated = true;
    };

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };

    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.once("error", (error) => finish(() => reject(error)));

    const timer = setTimeout(() => {
      if (child.pid && process.platform !== "win32") {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      } else {
        child.kill("SIGKILL");
      }
      finish(() => reject(new Error(`Command exceeded the ${options.timeoutMs} ms timeout.`)));
    }, options.timeoutMs);

    child.once("close", (code) => finish(() => {
      const exitCode = code ?? -1;
      if (!(options.allowedExitCodes || [0]).includes(exitCode)) {
        reject(new Error(`Command failed with exit code ${exitCode}.\n${output}`));
        return;
      }
      resolve({ exitCode, output: output.trim(), truncated });
    }));
  });
}
