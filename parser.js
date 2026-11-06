// GameLife Tracker — parser delle pagine categoria (Odoo eCommerce)
// Usa solo regex: funziona nel service worker (senza DOMParser) e in Node per i test.
(function (root) {
  const BASE = 'https://www.gamelife.it';

  function decode(s) {
    return String(s || '')
      .replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
      .replace(/\s+/g, ' ').trim();
  }

  function toNumber(s) {
    if (s == null) return null;
    const n = parseFloat(String(s).replace(/\./g, '').replace(',', '.'));
    return isFinite(n) ? n : null;
  }

  // stato: 'available' | 'last_units' | 'unavailable'
  function parseRows(card) {
    const out = {};
    const re = /<span class="(available|last_units|unavailable)"[^>]*>\s*<i class="fa [^"]*"><\/i>\s*(Nuovo|Usato)\s*<\/span>/g;
    const marks = [];
    let m;
    while ((m = re.exec(card))) marks.push({ idx: m.index, status: m[1], label: m[2] });
    marks.forEach((mk, i) => {
      const seg = card.slice(mk.idx, i + 1 < marks.length ? marks[i + 1].idx : card.length);
      const key = mk.label === 'Nuovo' ? 'new' : 'used';
      // prezzo effettivo: la prima span monetaria che NON è il prezzo di listino barrato
      let price = null, list = null;
      const pre = /data-oe-expression="([^"]*)"\s*>\s*<span class="oe_currency_value">([\d.,]+)<\/span>/g;
      let p;
      while ((p = pre.exec(seg))) {
        const expr = decode(p[1]);
        if (/compare_list_price/.test(expr)) list = toNumber(p[2]);
        else if (price == null) price = toNumber(p[2]);
      }
      if (price == null) {
        const any = seg.match(/<span class="oe_currency_value">([\d.,]+)<\/span>/);
        if (any) price = toNumber(any[1]);
      }
      out[key] = { status: mk.status, price, list };
    });
    return out;
  }

  function parseCategoryPage(html) {
    const t = String(html).replace(/\s+/g, ' ');
    const parts = t.split('<form role="article"').slice(1);
    const products = [];
    for (const raw of parts) {
      const card = raw.split('</form>')[0];
      const href = (card.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"/) || card.match(/<a[^>]*href="(\/[^"#?]+)"/) || [])[1];
      if (!href) continue;
      const name = decode((card.match(/<h2[^>]*>\s*<a[^>]*>\s*<span>([\s\S]*?)<\/span>/) || [])[1] ||
        (card.match(/aria-label="([^"]*)"/) || [])[1]);
      const img = (card.match(/<img src="([^"]+)"/) || [])[1];
      const sku = ((card.match(/alt="\[([A-Z0-9]+)_[A-Z]\]/) || [])[1]) || null;
      const tmpl = (card.match(/name="product_template_id" type="hidden" value="(\d+)"/) || [])[1];
      const slug = href.replace(/^\//, '').split(/[#?]/)[0];
      const rows = parseRows(card);
      products.push({
        id: slug,
        name,
        url: BASE + '/' + slug,
        img: img ? (img.startsWith('http') ? img : BASE + img).replace('/image_1024/', '/image_256/') : null,
        sku,
        templateId: tmpl ? +tmpl : null,
        preorder: /data-preorder="1"/.test(card),
        new: rows.new || null,
        used: rows.used || null,
      });
    }
    let maxPage = 0;
    const pr = /\/page\/(\d+)/g;
    let m;
    while ((m = pr.exec(t))) maxPage = Math.max(maxPage, +m[1]);
    return { products, maxPage };
  }

  const api = { parseCategoryPage, toNumber, decode, BASE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GLParser = api;
})(typeof self !== 'undefined' ? self : this);
