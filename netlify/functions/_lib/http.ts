// ตัวช่วยฝั่ง HTTP: response แบบ JSON, error ที่มี status, ตัวครอบจับ error

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** ตรวจ HTTP method ถ้าไม่ตรงให้โยน 405 */
export function methodGuard(req: Request, ...allowed: string[]): void {
  if (!allowed.includes(req.method)) {
    throw new HttpError(405, `method ${req.method} not allowed`);
  }
}

/** อ่าน body เป็น JSON แบบปลอดภัย (body ว่าง = อ็อบเจกต์ว่าง) */
export async function readJson<T = Record<string, unknown>>(req: Request): Promise<T> {
  const text = await req.text();
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
}

/** ครอบ handler เพื่อแปลง HttpError เป็น response และกัน error หลุด */
export async function run(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error("[unhandled]", e);
    return json({ error: "internal error" }, 500);
  }
}
