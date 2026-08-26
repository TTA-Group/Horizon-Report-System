// GET /api/massage/sheet?t=... — ฟอร์มเช็คชื่อฉบับพร้อมพิมพ์ เปิดได้โดยไม่ต้องล็อกอิน
//
// เปิดโดยไม่ล็อกอินเพราะผู้ดูแลกดจากในแอปไลน์แล้วหน้าไปเปิดที่เบราว์เซอร์ของเครื่อง
// ซึ่งไม่มี session ติดไปด้วย สิ่งที่กันไว้แทนคือลายเซ็นในลิงก์และอายุ 48 ชั่วโมง
// (ดู _lib/massage-token.ts) หน้านี้อ่านอย่างเดียว การกด มา/ไม่มา อยู่ในแอปที่ล็อกอินแล้ว

import { methodGuard, run } from "./_lib/http";
import { buildSheet, renderSheetHtml } from "./_lib/massage-sheet";
import { verifySheetToken } from "./_lib/massage-token";

function page(title: string, message: string, status: number): Response {
  return new Response(
    `<!DOCTYPE html><html lang="th"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>body{font-family:'Anuphan',system-ui,sans-serif;background:#EDF0F3;color:#15201B;margin:0;
display:grid;place-items:center;min-height:100vh;padding:24px}
.b{background:#fff;border-radius:14px;padding:30px 32px;max-width:420px;text-align:center}
h1{font-size:19px;margin:0 0 8px}p{font-size:14px;color:#5B6672;line-height:1.7;margin:0}</style>
</head><body><div class="b"><h1>${title}</h1><p>${message}</p></div></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

export default async (req: Request): Promise<Response> =>
  run(async () => {
    methodGuard(req, "GET");
    const url = new URL(req.url);

    const day = verifySheetToken((url.searchParams.get("t") ?? "").trim());
    if (!day) {
      return page(
        "ลิงก์นี้ใช้ไม่ได้แล้ว",
        "ลิงก์ฟอร์มเช็คชื่อมีอายุ 48 ชั่วโมงเพื่อความปลอดภัย กรุณากดปุ่มดาวน์โหลดในแอปอีกครั้งเพื่อขอลิงก์ใหม่",
        403,
      );
    }

    // ?print=0 ไว้ดูเฉย ๆ โดยไม่ให้หน้าต่างสั่งพิมพ์เด้งขึ้นมาเอง
    const sheet = await buildSheet(day);
    return new Response(renderSheetHtml(sheet, url.searchParams.get("print") !== "0"), {
      headers: {
        "content-type": "text/html; charset=utf-8",
        // มีชื่อพนักงานอยู่ในหน้า ห้ามให้ตัวกลางเก็บสำเนาหรือให้เครื่องค้นหาเก็บดัชนี
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "x-robots-tag": "noindex, nofollow",
      },
    });
  });
