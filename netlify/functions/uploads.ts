// POST /api/uploads — อัปโหลดภาพแนบ คืน URL (spec หัวข้อ 6 / 9.2 / 10)
//
// รับภาพที่ถูกบีบอัดจากเบราว์เซอร์แล้ว (ด้านยาว <= 1600px, JPEG/WebP คุณภาพ ~0.7)
// body: { filename, content_type, content_base64 }
//
// การจัดเก็บใช้ Supabase Storage ผ่าน REST (ตั้งค่า STORAGE_BUCKET_URL + STORAGE_SERVICE_KEY)
// ถ้ายังไม่ได้ตั้งค่า จะตอบ 501 เพื่อให้ผู้ดูแลไปตั้งค่าก่อน

import type { Config } from "@netlify/functions";
import { getSession, requireActive } from "./_lib/auth";
import { HttpError, json, methodGuard, readJson, run } from "./_lib/http";

interface Body {
  filename?: string;
  content_type?: string;
  content_base64?: string;
}

const MAX_BYTES = 1_000_000; // ปฏิเสธไฟล์ที่หลังบีบอัดแล้วยังเกิน 1 MB (spec หัวข้อ 9.2)

export default async (req: Request): Promise<Response> =>
  run(async () => {
    methodGuard(req, "POST");
    const s = await getSession(req);
    requireActive(s);

    const body = await readJson<Body>(req);
    const contentType = (body.content_type ?? "").trim();
    const b64 = body.content_base64 ?? "";
    if (!contentType.startsWith("image/")) throw new HttpError(400, "อนุญาตเฉพาะไฟล์ภาพ");
    if (!b64) throw new HttpError(400, "ไม่พบข้อมูลไฟล์");

    const bytes = Buffer.from(b64, "base64");
    if (bytes.byteLength === 0) throw new HttpError(400, "ไฟล์ไม่ถูกต้อง");
    if (bytes.byteLength > MAX_BYTES) throw new HttpError(413, "ไฟล์ใหญ่เกิน 1 MB กรุณาบีบอัดก่อนอัปโหลด");

    const base = process.env.STORAGE_BUCKET_URL;
    const key = process.env.STORAGE_SERVICE_KEY;
    if (!base || !key) {
      throw new HttpError(501, "ยังไม่ได้ตั้งค่าที่เก็บไฟล์ (STORAGE_BUCKET_URL / STORAGE_SERVICE_KEY)");
    }

    // ตั้งชื่อไฟล์: <employeeId>/<timestamp>-<random>.<ext>
    const ext = contentType.split("/")[1]?.split("+")[0] || "jpg";
    const path = `${s.employee.id}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const putUrl = `${base.replace(/\/$/, "")}/${path}`;

    const res = await fetch(putUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        apikey: key,
        "content-type": contentType,
        "x-upsert": "true",
      },
      body: bytes,
    });
    if (!res.ok) {
      console.error("[uploads]", res.status, await res.text().catch(() => ""));
      throw new HttpError(502, "อัปโหลดไฟล์ไม่สำเร็จ");
    }

    // URL สาธารณะของ Supabase Storage
    const publicUrl = putUrl.replace("/object/", "/object/public/");
    return json({ ok: true, url: publicUrl });
  });

export const config: Config = { path: "/api/uploads" };
