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
const APP_SHELL = new Set(["/", "/index.html", "/app.js", "/config.js"]);

export function serveAsset(res: Response, pathname: string): Response {
  if (!APP_SHELL.has(pathname)) return res;

  const headers = new Headers(res.headers);
  headers.set("cache-control", "no-store, must-revalidate");
  // ต้องเอา etag กับ last-modified ออกด้วย ไม่งั้นตัวกลางยังตอบ 304 จากสำเนาเก่าได้อยู่
  headers.delete("etag");
  headers.delete("last-modified");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
