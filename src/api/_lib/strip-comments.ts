// ตัดคอมเมนต์ออกจากไฟล์หน้าเว็บ "ตอนส่งให้เบราว์เซอร์" ไม่ใช่ลบจากไฟล์ต้นทาง
//
// เจ้าของงานไม่ต้องการให้คนที่กด inspect element อ่านคำอธิบายในโค้ดได้ แต่คอมเมนต์ในนี้
// เขียนเหตุผลไว้ว่า "ทำไมต้องทำแบบนี้" ซึ่งคนมาทำงานต่อต้องอ่าน (ดู CLAUDE.md)
// ตัดตอนส่งจึงได้ทั้งสองอย่าง — ต้นทางเก็บความรู้ไว้ครบ ส่วนคนเปิดดูหน้าเว็บไม่เห็นอะไรเลย
//
// **ห้ามใช้ regex ตัดตรง ๆ เด็ดขาด** ไฟล์พวกนี้มีทั้ง "https://..." ในสตริง และ regex อย่าง
// /[&<>"]/g ที่มีเครื่องหมายคำพูดอยู่ข้างใน ตัดด้วย regex เมื่อไหร่โค้ดพังทันที
// จึงต้องไล่อ่านทีละตัวอักษรและรู้ตลอดว่าตอนนี้อยู่ในสตริง เทมเพลต หรือ regex

/** ตัวอักษรที่ถ้ามาก่อน "/" แปลว่านั่นคือตัวหาร ไม่ใช่จุดเริ่มของ regex */
const DIV_BEFORE = /[\w$)\]]/;

/** คำที่ลงท้ายด้วยตัวอักษรแต่ตามด้วย regex ได้ เช่น return /abc/.test(x) */
const REGEX_AFTER = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void",
  "throw", "case", "do", "else", "yield", "await",
]);

/** "/" ที่ตำแหน่งนี้เป็นจุดเริ่มของ regex หรือเป็นตัวหาร — ดูจากสิ่งที่พิมพ์ออกไปแล้ว */
function startsRegex(out: string): boolean {
  const trimmed = out.replace(/\s+$/, "");
  if (trimmed === "") return true;
  const last = trimmed[trimmed.length - 1];
  if (!DIV_BEFORE.test(last)) return true;
  // ลงท้ายด้วยตัวอักษร อาจเป็นคำอย่าง return ซึ่งตามด้วย regex ได้
  const word = /[\w$]+$/.exec(trimmed);
  return word !== null && REGEX_AFTER.has(word[0]);
}

/**
 * ตัดคอมเมนต์ออกจากจาวาสคริปต์
 *
 * แทนคอมเมนต์ด้วยช่องว่างหนึ่งตัว ไม่ใช่ลบทิ้งเฉย ๆ เพราะโค้ดอย่าง `a/**\/b` จะกลายเป็น `ab`
 * และบรรทัดที่เหลือแต่ช่องว่างถูกยุบทีหลัง จึงไม่มีบรรทัดว่างค้างเป็นพรืด
 */
export function stripJs(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;

  while (i < n) {
    const c = src[i];
    const d = src[i + 1];

    // "//" เป็นคอมเมนต์เสมอ — regex ว่างเปล่าเขียนแบบนี้ไม่ได้ ต้องเป็น /(?:)/
    if (c === "/" && d === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    // "/*" เป็นคอมเมนต์เสมอ — regex ที่ขึ้นต้นด้วย * ผิดไวยากรณ์
    if (c === "/" && d === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      out += " ";
      continue;
    }

    // สตริงเดี่ยวและคู่ — ข้ามทั้งก้อน รวมทั้ง \" ที่อยู่ข้างใน
    if (c === '"' || c === "'") {
      out += c;
      i++;
      while (i < n && src[i] !== c) {
        if (src[i] === "\\") { out += src[i]; i++; }
        if (i < n) { out += src[i]; i++; }
      }
      out += src[i] ?? "";
      i++;
      continue;
    }

    // เทมเพลตลิเทอรัล — ข้างในมี ${...} ที่เป็นโค้ดจริง ซ้อนกันได้หลายชั้น
    // จึงต้องวนกลับเข้าตัวเองแทนที่จะข้ามทั้งก้อนแบบสตริงธรรมดา
    if (c === "`") {
      out += c;
      i++;
      while (i < n && src[i] !== "`") {
        if (src[i] === "\\") { out += src[i] + (src[i + 1] ?? ""); i += 2; continue; }
        if (src[i] === "$" && src[i + 1] === "{") {
          // หาปีกกาปิดที่คู่กันจริง แล้วส่งเนื้อข้างในเข้าไปตัดคอมเมนต์อีกรอบ
          let depth = 1;
          let j = i + 2;
          while (j < n && depth > 0) {
            const k = src[j];
            if (k === "{") depth++;
            else if (k === "}") depth--;
            else if (k === '"' || k === "'" || k === "`") {
              const q = k;
              j++;
              while (j < n && src[j] !== q) j += src[j] === "\\" ? 2 : 1;
            }
            j++;
          }
          out += "${" + stripJs(src.slice(i + 2, j - 1)) + "}";
          i = j;
          continue;
        }
        out += src[i];
        i++;
      }
      out += src[i] ?? "";
      i++;
      continue;
    }

    // regex ลิเทอรัล — ข้างใน [] มีทั้ง " และ / ได้ ต้องรู้ว่ากำลังอยู่ในวงเล็บเหลี่ยม
    if (c === "/" && startsRegex(out)) {
      out += c;
      i++;
      let inClass = false;
      while (i < n) {
        const k = src[i];
        if (k === "\\") { out += k + (src[i + 1] ?? ""); i += 2; continue; }
        if (k === "[") inClass = true;
        else if (k === "]") inClass = false;
        else if (k === "/" && !inClass) break;
        else if (k === "\n") break;   // regex ข้ามบรรทัดไม่ได้ — กันหลงไปทั้งไฟล์
        out += k;
        i++;
      }
      out += src[i] ?? "";
      i++;
      continue;
    }

    out += c;
    i++;
  }
  return tidy(out);
}

/** ยุบบรรทัดที่เหลือแต่ช่องว่างหลังตัดคอมเมนต์ออก และตัดช่องว่างท้ายบรรทัด */
function tidy(s: string): string {
  return s
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+/, "");
}

/** ตัดคอมเมนต์ /* *\/ ออกจาก CSS โดยไม่แตะข้อความที่อยู่ในเครื่องหมายคำพูด */
export function stripCss(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'") {
      out += c;
      i++;
      while (i < n && src[i] !== c) {
        if (src[i] === "\\") { out += src[i]; i++; }
        if (i < n) { out += src[i]; i++; }
      }
      out += src[i] ?? "";
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return tidy(out);
}

/**
 * ตัดคอมเมนต์ออกจาก HTML — ทั้ง <!-- --> และคอมเมนต์ CSS ที่อยู่ใน <style>
 *
 * ไฟล์ของระบบนี้เรียกสคริปต์จากภายนอกทั้งหมด ไม่มี <script> ที่เขียนโค้ดคาไว้ในหน้า
 * จึงไม่ต้องแตะเนื้อใน <script> เลย ถ้าวันหนึ่งมีขึ้นมา ต้องมาเพิ่มตรงนี้
 */
export function stripHtml(src: string): string {
  // แยก <style> ออกมาตัดด้วยกฎของ CSS ก่อน แล้วค่อยตัด <!-- --> ที่เหลือ
  const parts: string[] = [];
  let rest = src;
  let guard = 0;
  while (guard++ < 50) {
    const open = rest.search(/<style\b[^>]*>/i);
    if (open === -1) break;
    const headEnd = rest.indexOf(">", open) + 1;
    const close = rest.toLowerCase().indexOf("</style>", headEnd);
    if (close === -1) break;
    parts.push(stripHtmlOnly(rest.slice(0, headEnd)));
    parts.push(stripCss(rest.slice(headEnd, close)));
    rest = rest.slice(close);
  }
  parts.push(stripHtmlOnly(rest));
  return parts.join("");
}

function stripHtmlOnly(s: string): string {
  return tidy(s.replace(/<!--[\s\S]*?-->/g, ""));
}
