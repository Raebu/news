declare module "node:assert/strict" {
  const assert: {
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): asserts value;
    rejects(block: () => Promise<unknown>, error?: RegExp | ((error: unknown) => boolean)): Promise<void>;
    throws(block: () => unknown, error?: RegExp | ((error: unknown) => boolean)): void;
  };
  export default assert;
}

declare module "node:test" {
  export default function test(name: string, fn: () => void | Promise<void>): void;
}

declare module "node:http" {
  export interface IncomingMessage { method?: string; url?: string; }
  export interface ServerResponse {
    statusCode: number;
    setHeader(name: string, value: string): void;
    end(body?: string): void;
  }
  export function createServer(handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>): {
    listen(port: number, host: string, callback?: () => void): void;
  };
}

declare const process: {
  env: Record<string, string | undefined>;
  stdout: { write(message: string): void };
  stderr: { write(message: string): void };
  exitCode?: number;
};
