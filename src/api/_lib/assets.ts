// การเสิร์ฟไฟล์หน้าเว็บ — กันไม่ให้เบราว์เซอร์หรือตัวกลางเก็บ "ตัวแอป" ของเก่าเอาไว้
//
// เจอมาแล้วสองครั้ง และหลอกทั้งสองครั้งเพราะดูเหมือน deploy ไม่ขึ้น ทั้งที่ขึ้นไปแล้ว
//   ครั้งแรก config.js ค้าง  -> หน้าจอขึ้นว่า "ยังไม่ได้ตั้งค่า LIFF"
//   ครั้งที่สอง app.js ค้าง  -> หน้าจองยังเป็นหน้าตาแบบเก่า ทั้งที่แก้ไปแล้ว
// เบราว์เซอร์ในแอปไลน์เก็บสำเนาแน่นเป็นพิเศษ และผู้ใช้กดล้างแคชเองไม่ได้
//
// สามไฟล์นี้คือตัวแอปทั้งหมด รวมกันไม่ถึงร้อยกิโลไบต์ และเป็นระบบภายในที่มีคนใช้หลักร้อย
// ยอมให้โหลดใหม่ทุกครั้ง แลกกับการไม่ต้องมานั่งไล่ว่าทำไมแก้แล้วหน้าจอไม่เปลี่ยน
// ส่วนรูป ฟอนต์ ไอคอน ยังเก็บสำเนาได้ตามปกติ เพราะแทบไม่เปลี่ยนและหนักกว่ามาก
import { stripHtml, stripJs } from "./strip-comments";

const APP_SHELL = new Set(["/", "/index.html", "/app.js", "/config.js"]);

/**
 * ผลการตัดคอมเมนต์ที่ทำไปแล้ว เก็บไว้ใช้ซ้ำตลอดอายุของ isolate
 *
 * ตัดคอมเมนต์ต้องไล่อ่านทีละตัวอักษรทั้งไฟล์ ถ้าทำใหม่ทุกคำขอจะกินเวลาประมวลผลฟรี ๆ
 * แผนฟรีของ Cloudflare ให้เวลาประมวลผล 10 มิลลิวินาทีต่อคำขอ จึงคุ้มที่จะจำไว้
 *
 * คีย์เป็น "เส้นทาง + ความยาวไฟล์" — ไฟล์เปลี่ยนเมื่อไหร่ความยาวก็เปลี่ยนตาม
 * ของเก่าจึงไม่ถูกใช้ข้าม deploy (และ isolate ก็เกิดใหม่ตอน deploy อยู่แล้ว)
 */
const stripped = new Map<string, string>();

/** ไฟล์ที่ต้องตัดคอมเมนต์ก่อนส่ง — เฉพาะที่เบราว์เซอร์โหลดไปอ่านได้ */
function stripperFor(pathname: string): ((s: string) => string) | null {
  if (pathname === "/app.js" || pathname === "/config.js") return stripJs;
  if (pathname === "/" || pathname === "/index.html") return stripHtml;
  return null;
}

/**
 * ตัดคอมเมนต์ออกก่อนส่งให้เบราว์เซอร์
 *
 * เจ้าของงานไม่ต้องการให้คนที่กด inspect element อ่านคำอธิบายในโค้ดได้ แต่คอมเมนต์
 * เป็นสิ่งที่คนมาทำงานต่อต้องอ่าน จึงตัดตอนส่ง ไม่ลบจากไฟล์ต้นทาง
 *
 * ตัดพลาดแล้วหน้าเว็บพังทั้งระบบ จึงกันไว้สองชั้น: ตัวตัดรู้จักสตริงกับ regex
 * (ดู strip-comments.ts) และถ้าพังจริงตรงนี้จะส่งไฟล์เดิมไปแทนที่จะส่งของเสีย
 */
async function stripBody(res: Response, pathname: string): Promise<Response> {
  const strip = stripperFor(pathname);
  if (!strip) return res;

  // ต้องอ่านเนื้อไฟล์เก็บไว้ก่อนเข้า try — ร่างของ Response อ่านได้ครั้งเดียว
  // ถ้าไปอ่านข้างใน try แล้วตัวตัดพัง จะเหลือแต่ร่างเปล่า ส่งกลับไปเป็นหน้าขาว
  const src = await res.text();
  let out = src;
  try {
    const key = `${pathname}:${src.length}`;
    const hit = stripped.get(key);
    if (hit === undefined) {
      out = strip(src);
      stripped.set(key, out);
    } else {
      out = hit;
    }
  } catch (e) {
    console.error("[assets] ตัดคอมเมนต์ไม่สำเร็จ ส่งไฟล์เดิมไปแทน", pathname, e);
    out = src;
  }
  return new Response(out, { status: res.status, statusText: res.statusText, headers: res.headers });
}

export async function serveAsset(res: Response, pathname: string): Promise<Response> {
  if (!APP_SHELL.has(pathname)) return res;

  const body = await stripBody(res, pathname);
  const headers = new Headers(body.headers);
  headers.set("cache-control", "no-store, must-revalidate");
  // ต้องเอา etag กับ last-modified ออกด้วย ไม่งั้นตัวกลางยังตอบ 304 จากสำเนาเก่าได้อยู่
  headers.delete("etag");
  headers.delete("last-modified");
  // ความยาวเปลี่ยนไปหลังตัดคอมเมนต์ ปล่อยให้ runtime คิดใหม่เอง
  headers.delete("content-length");
  return new Response(body.body, { status: body.status, statusText: body.statusText, headers });
}
