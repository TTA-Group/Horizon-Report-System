// POST /api/auth/session — ตรวจ token คืนข้อมูลพนักงานและสถานะการผูกบัญชี (spec หัวข้อ 6)

import type { Config } from "@netlify/functions";
import { getSession } from "./_lib/auth";
import { json, methodGuard, run } from "./_lib/http";

export default async (req: Request): Promise<Response> =>
  run(async () => {
    methodGuard(req, "POST");
    const s = await getSession(req);
    return json({
      linked: s.linked,
      suspended: s.employee?.status === "suspended",
      is_admin: s.isAdmin,
      dept_roles: s.deptRoles,
      display_name: s.displayName ?? null,
      employee: s.employee
        ? {
            id: s.employee.id,
            employee_code: s.employee.employee_code,
            full_name: s.employee.full_name,
            department_name: s.employee.department_name,
            floor: s.employee.floor,
            email: s.employee.email,
            status: s.employee.status,
          }
        : null,
    });
  });

export const config: Config = { path: "/api/auth/session" };
