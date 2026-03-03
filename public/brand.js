export function logoSVG(size = 44){
  return `
  <svg width="${size}" height="${size}" viewBox="0 0 64 64" aria-label="FroteBite logo" role="img">
    <defs>
      <linearGradient id="flameFill" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#FFB100"/>
        <stop offset="0.55" stop-color="#FF6A00"/>
        <stop offset="1" stop-color="#FF2E2E"/>
      </linearGradient>
      <linearGradient id="fFill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#FF3A3A"/>
        <stop offset="1" stop-color="#C4002B"/>
      </linearGradient>
    </defs>
    <path fill="url(#flameFill)"
      d="M33 4c2 9-3 12-6 17-4 6-1 10 3 12-7 0-13-6-13-16C17 9 23 5 26 1c0 7 4 10 7 13z
         M35 12c8 8 13 15 13 25 0 14-10 22-22 22S4 51 4 39c0-9 6-14 14-18-2 8 4 12 10 12
         9 0 13-10 7-21z"/>
    <path fill="url(#fFill)"
      d="M26 20h20c1.7 0 3 1.3 3 3v3c0 1.7-1.3 3-3 3H34v5h10c1.7 0 3 1.3 3 3v2.6c0 1.7-1.3 3-3 3H34v9.4
         c0 1.7-1.3 3-3 3h-4c-1.7 0-3-1.3-3-3V23c0-1.7 1.3-3 3-3z"/>
  </svg>`;
}

export async function api(path, options){
  const res = await fetch(path, options);
  const data = await res.json().catch(()=> ({}));
  if(!res.ok) throw new Error(data.error || ("HTTP " + res.status));
  return data;
}

// Session
export function saveSession(user){ localStorage.setItem("fbm_user", JSON.stringify(user)); }
export function loadSession(){ try { return JSON.parse(localStorage.getItem("fbm_user")||"null"); } catch { return null; } }
export function clearSession(){ localStorage.removeItem("fbm_user"); }

// Contacts (manual added)
const CONTACTS_KEY = "fbm_contacts";
export function loadContacts(){ try { return JSON.parse(localStorage.getItem(CONTACTS_KEY) || "[]"); } catch { return []; } }
export function saveContacts(list){ localStorage.setItem(CONTACTS_KEY, JSON.stringify(list)); }
export function addContact(id){
  const list = loadContacts();
  const n = Number(id);
  if(!n) return list;
  if(!list.includes(n)) list.push(n);
  saveContacts(list);
  return list;
}

// Names
export function displayName(user){
  if(!user) return "User";
  const nn = String(user.nickname || "").trim();
  if(nn) return nn;
  return `User #${user.id}`;
}

// ---- Themes ----
const THEME_KEY = "fbm_theme";
export const THEMES = [
  { id: "ember", name: "Ember (Огонь)" },
  { id: "midnight", name: "Midnight (Тёмная)" },
  { id: "sunset", name: "Sunset (Закат)" },
];

export function getTheme(){
  return localStorage.getItem(THEME_KEY) || "ember";
}
export function setTheme(id){
  localStorage.setItem(THEME_KEY, id);
  document.documentElement.setAttribute("data-theme", id);
}
export function initTheme(){
  document.documentElement.setAttribute("data-theme", getTheme());
}

// ---- Avatars ----
function hash32(x){
  let h = 2166136261;
  const s = String(x);
  for(let i=0;i<s.length;i++){
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function hueFromId(id){
  return hash32(id) % 360;
}

export function initialsFromName(name){
  const t = String(name || "").trim();
  if(!t) return "U";
  const parts = t.split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] || "U";
  const second = parts.length > 1 ? (parts[1]?.[0] || "") : (t.length > 1 ? t[1] : "");
  return (first + (second || "")).toUpperCase();
}

export function avatarHTML(user, size=32){
  const id = user?.id ?? 0;
  const name = displayName(user);
  const ini = initialsFromName(name);
  const hue = hueFromId(id);
  // gradient derived from hue
  const bg = `linear-gradient(135deg, hsl(${hue} 95% 55%), hsl(${(hue+35)%360} 95% 55%))`;
  return `
    <div class="avatar" style="width:${size}px;height:${size}px;background:${bg}">
      <span>${ini}</span>
    </div>
  `;
}

// Rich HTML sanitizer: allow only <b><i><u><br>
export function sanitizeRichHtml(html){
  const tmp = document.createElement("div");
  tmp.innerHTML = String(html || "");
  tmp.querySelectorAll("script,style").forEach(n => n.remove());

  const allowed = new Set(["B","I","U","BR"]);
  const walk = (node) => {
    const children = Array.from(node.childNodes);
    for(const ch of children){
      if(ch.nodeType === Node.ELEMENT_NODE){
        if(!allowed.has(ch.tagName)){
          const frag = document.createDocumentFragment();
          while(ch.firstChild) frag.appendChild(ch.firstChild);
          ch.replaceWith(frag);
        } else {
          Array.from(ch.attributes).forEach(a => ch.removeAttribute(a.name));
          walk(ch);
        }
      } else if(ch.nodeType === Node.TEXT_NODE){
        // ok
      } else {
        ch.remove();
      }
    }
  };
  walk(tmp);

  // normalize div/p to br
  tmp.querySelectorAll("div,p").forEach(el => {
    const br = document.createElement("br");
    el.after(br);
    el.replaceWith(...Array.from(el.childNodes));
  });

  return tmp.innerHTML.trim();
}