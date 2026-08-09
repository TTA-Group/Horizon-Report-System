// GET /api/masters — หมวด ฝ่าย ชั้น ระดับความเร่งด่วน (spec หัวข้อ 6)

import type { Config } from "@netlify/functions";
import { CATEGORIES, FLOORS, URGENCIES } from "./_lib/constants";
import { json, methodGuard, run } from "./_lib/http";

export default async (req: Request): Promise<Response> =>
  run(async () => {
    methodGuard(req, "GET");
    return json({
      categories: CATEGORIES.map((c) => ({ code: c.code, label: c.label, dept_code: c.deptCode })),
      floors: FLOORS,
      urgencies: URGENCIES,
    });
  });

export const config: Config = { path: "/api/masters" };
