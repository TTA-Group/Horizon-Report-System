// GET /api/masters — หมวด ฝ่าย ชั้น ระดับความเร่งด่วน (spec หัวข้อ 6)

import type { Config } from "@netlify/functions";
import { CATEGORIES, FLOORS, URGENCIES } from "./_lib/constants";
import { db } from "./_lib/db";
import { json, methodGuard, run } from "./_lib/http";

export default async (req: Request): Promise<Response> =>
  run(async () => {
    methodGuard(req, "GET");
    const sql = db();
    const departments = await sql<{ code: string; name: string }[]>`
      SELECT code, name FROM departments WHERE is_active = true ORDER BY code
    `;
    return json({
      categories: CATEGORIES.map((c) => ({ code: c.code, label: c.label, dept_code: c.deptCode })),
      departments: [...departments],
      floors: FLOORS,
      urgencies: URGENCIES,
    });
  });

export const config: Config = { path: "/api/masters" };
