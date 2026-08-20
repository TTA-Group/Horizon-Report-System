// GET /api/reports/view?t=... — หน้ารายงานฉบับเต็ม เปิดได้โดยไม่ต้องล็อกอิน
//
// จุดประสงค์คือส่งต่อให้ผู้บริหารที่ไม่ได้ใช้แอปนี้ ลิงก์จึงต้องเปิดจากเบราว์เซอร์ทั่วไปได้
// สิ่งที่กันไว้แทนการล็อกอินคือ ลิงก์ถูกเซ็นกำกับ (แก้ตัวเลขในลิงก์ไม่ได้) และหมดอายุเอง
// ดู _lib/report-token.ts — ใครถือลิงก์ก็เปิดได้ เป็นการแลกโดยตั้งใจเพื่อให้ส่งต่อได้จริง
//
// &format=csv คืนข้อมูลดิบหนึ่งบรรทัดต่อหนึ่งเรื่อง สำหรับเอาไปคิดต่อในตารางคำนวณ

import { methodGuard, run } from "./_lib/http";
import { renderReportCsv, renderReportHtml } from "./_lib/report-html";
import { verifyReportToken } from "./_lib/report-token";
import { buildDeptReport } from "./_lib/reports";

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
    const claim = verifyReportToken((url.searchParams.get("t") ?? "").trim());
    if (!claim) {
      return page(
        "ลิงก์นี้ใช้ไม่ได้แล้ว",
        "ลิงก์รายงานมีอายุจำกัดเพื่อความปลอดภัย กรุณาขอลิงก์ใหม่จากหัวหน้าฝ่ายหรือฝ่ายบุคคล",
        403,
      );
    }

    const report = await buildDeptReport(claim.d, claim.p, claim.o);
    if (!report) return page("ไม่พบข้อมูล", "ไม่พบฝ่ายของรายงานนี้ในระบบแล้ว", 404);

    if (url.searchParams.get("format") === "csv") {
      const name = `report-${report.department_code}-${claim.p}-${report.range_label.replace(/[^0-9]+/g, "-")}.csv`;
      return new Response(renderReportCsv(report), {
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="${name}"`,
        },
      });
    }

    const csvUrl = `${url.pathname}?t=${encodeURIComponent(url.searchParams.get("t") ?? "")}&format=csv`;
    return new Response(renderReportHtml(report, csvUrl), {
      headers: {
        "content-type": "text/html; charset=utf-8",
        // ไม่ให้ตัวกลางเก็บสำเนาหน้ารายงานไว้ เพราะมีข้อมูลภายในองค์กร
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "x-robots-tag": "noindex, nofollow",
      },
    });
  });
