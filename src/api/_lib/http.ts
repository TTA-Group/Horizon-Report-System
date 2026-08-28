// ตัวช่วยฝั่ง HTTP: response แบบ JSON, error ที่มี status, ตัวครอบจับ error

export class HttpError extends Error {
  status: number;
  /**
   * รหัสสั้น ๆ ให้หน้าจอแยกกรณีได้โดยไม่ต้องเดาจากข้อความ
   * ใช้เฉพาะกรณีที่หน้าจอต้องทำอะไรต่อจริง ๆ เช่น พาผู้ใช้กลับไปหน้าลงทะเบียน
   */
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
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

/**
 * ดึงรายการออกมาจาก body ที่เครื่องมือ low-code ส่งมา ไม่ว่าจะส่งมาในรูปแบบไหน
 *
 * Power Automate แปลงอาร์เรย์เป็นข้อความเงียบ ๆ เมื่อเอาไปแทรกกลาง JSON ที่พิมพ์เอง
 * สิ่งที่มาถึงจึงเป็นได้ทั้งสามแบบ และคนตั้งค่าฝั่งนั้นไม่มีทางรู้ว่าตัวเองส่งแบบไหนอยู่
 *   [ {...} ]                 ส่งเป็นรายการมาตรง ๆ
 *   { key: [ {...} ] }        ห่อด้วยชื่อฟิลด์
 *   { key: "[ {...} ]" }      ห่อแล้วถูกแปลงเป็นข้อความ
 *
 * รับให้หมดทั้งสามแบบ เพราะปลายทางตรวจเนื้อในทีละรายการอยู่แล้ว การบังคับรูปแบบ
 * จึงไม่ได้ทำให้ปลอดภัยขึ้น มีแต่ทำให้คนตั้งค่าต้องลองผิดลองถูกอยู่นาน
 */
export function listFrom(body: unknown, key: string): unknown[] | null {
  // แกะข้อความที่เป็น JSON ซ้อนกันออกทีละชั้น บางเครื่องมือห่อไว้สองชั้นก็มี
  const unwrap = (v: unknown, depth: number): unknown => {
    if (depth >= 3 || typeof v !== "string") return v;
    try {
      return unwrap(JSON.parse(v), depth + 1);
    } catch {
      return v;
    }
  };

  const top = unwrap(body, 0);
  if (Array.isArray(top)) return top;
  if (top && typeof top === "object") {
    const inner = unwrap((top as Record<string, unknown>)[key], 0);
    if (Array.isArray(inner)) return inner;
  }
  return null;
}

/**
 * อธิบายสั้น ๆ ว่าได้อะไรมา — ใช้ต่อท้ายข้อความปฏิเสธของเส้นทางที่เรียกจากเครื่องต่อเครื่อง
 *
 * ไม่มีคนนั่งดูหน้าจอตอนที่มันพัง คนตั้งค่าเห็นแค่ "BadRequest" แล้วต้องเดาต่อเอง
 * บอกไปเลยว่าได้อะไรมาจะจบเร็วกว่ามาก — เส้นทางพวกนี้ผ่านด่าน secret มาแล้ว
 * ผู้เรียกจึงเป็นเจ้าของข้อมูลนั้นอยู่แล้ว ไม่ได้เปิดอะไรให้คนนอกเห็นเพิ่ม
 */
export function describeBody(raw: string, max = 160): string {
  const text = raw.trim();
  if (!text) return "ไม่มี body มาเลย";
  return `ได้มาเป็น: ${text.length > max ? `${text.slice(0, max)}…` : text}`;
}

/**
 * สรุปข้อผิดพลาดเป็นข้อความสั้น ๆ ที่ปลอดภัยพอจะส่งออกไปได้
 * ตัดสตริงเชื่อมต่อฐานข้อมูลทิ้ง เพราะมีรหัสผ่านอยู่ข้างใน
 */
export function safeErrorText(e: unknown, max = 200): string {
  const raw = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  const scrubbed = raw.replace(/postgres(?:ql)?:\/\/\S+/gi, "[connection-string]");
  return scrubbed.length > max ? `${scrubbed.slice(0, max)}…` : scrubbed;
}

/** ครอบ handler เพื่อแปลง HttpError เป็น response และกัน error หลุด */
export async function run(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof HttpError) {
      return json(e.code ? { error: e.message, code: e.code } : { error: e.message }, e.status);
    }
    console.error("[unhandled]", e);
    return json({ error: "internal error" }, 500);
  }
}
