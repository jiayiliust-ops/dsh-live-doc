/**
 * dsh-live-doc — dependency-free DOCX writer.
 *
 * The panel's content is plain blocks and inline HTML, so the export only needs
 * a small, predictable slice of WordprocessingML: A4 page setup, a handful of
 * named styles, bullet/number lists, and inline bold/italic/underline/strike/
 * code/links. Everything is built here and zipped with `node:zlib`, so the
 * plugin needs no runtime dependency and no Office installation.
 *
 * @module dsh-live-doc/docx
 */

import { crc32, deflateRawSync } from 'node:zlib';
import { escapeHtml, htmlToText } from './store.js';

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** XML-escape text for a Word run. */
function xml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\u0000/g, '');
}

/** One `<w:r>` with the run properties for the active inline state. */
function run(text, marks) {
  if (text.length === 0) return '';
  const properties = [];
  if (marks.bold) properties.push('<w:b/>');
  if (marks.italic) properties.push('<w:i/>');
  if (marks.underline) properties.push('<w:u w:val="single"/>');
  if (marks.strike) properties.push('<w:strike/>');
  if (marks.code) {
    properties.push('<w:rStyle w:val="CodeChar"/>');
    properties.push('<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="Consolas"/>');
    properties.push('<w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/>');
  }
  if (marks.link) {
    properties.push('<w:color w:val="0563C1"/>');
    properties.push('<w:u w:val="single"/>');
  }
  const rPr = properties.length > 0 ? `<w:rPr>${properties.join('')}</w:rPr>` : '';
  return `<w:r>${rPr}<w:t xml:space="preserve">${xml(text)}</w:t></w:r>`;
}

/**
 * Turn sanitized inline HTML into Word runs.
 * @param html - inline HTML from one block.
 * @returns WordprocessingML run XML.
 */
export function inlineRuns(html) {
  const source = String(html ?? '');
  const parts = source.split(/(<\/?(?:strong|b|em|i|u|s|del|code|a)(?:\s[^>]*)?>|<br\s*\/?>)/i);
  const marks = { bold: false, italic: false, underline: false, strike: false, code: false, link: false };
  const out = [];
  for (const part of parts) {
    if (part.length === 0) continue;
    const tag = /^<\/?([a-z]+)/i.exec(part)?.[1]?.toLowerCase();
    const closing = part.startsWith('</');
    if (tag === 'br') {
      out.push('<w:r><w:br/></w:r>');
      continue;
    }
    if (tag !== undefined) {
      if (tag === 'strong' || tag === 'b') marks.bold = !closing;
      else if (tag === 'em' || tag === 'i') marks.italic = !closing;
      else if (tag === 'u') marks.underline = !closing;
      else if (tag === 's' || tag === 'del') marks.strike = !closing;
      else if (tag === 'code') marks.code = !closing;
      else if (tag === 'a') marks.link = !closing;
      continue;
    }
    const text = part
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&');
    out.push(run(text, { ...marks }));
  }
  return out.join('');
}

/** Paragraph properties per block type. */
function paragraphProperties(type) {
  switch (type) {
    case 'h1': return '<w:pStyle w:val="Heading1"/>';
    case 'h2': return '<w:pStyle w:val="Heading2"/>';
    case 'h3': return '<w:pStyle w:val="Heading3"/>';
    case 'ul': return '<w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>';
    case 'ol': return '<w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr>';
    case 'quote': return '<w:pStyle w:val="Quote"/>';
    case 'code': return '<w:pStyle w:val="Code"/>';
    case 'hr': return '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="999999"/></w:pBdr>';
    default: return '';
  }
}

/** Printable content width in EMU (A4 minus 1in margins, ~6.27in). */
const MAX_IMAGE_EMU = 5_700_000;
/** EMU per CSS pixel at 96 DPI. */
const EMU_PER_PX = 9_525;
/** Fallback aspect ratio when the host could not sniff the image size. */
const FALLBACK_PX = 800;
const FALLBACK_PY = 600;

/** One block as a Word paragraph. */
function paragraph(block) {
  const pPr = paragraphProperties(block.type);
  const body = block.type === 'hr' ? '' : inlineRuns(block.html);
  const pPrXml = pPr.length > 0 ? `<w:pPr>${pPr}</w:pPr>` : '';
  return `<w:p>${pPrXml}${body}</w:p>`;
}

/** Cell paragraph, used by both header and body rows. */
function tableCell(html, header) {
  const content = header && html.length > 0 ? `<strong>${html}</strong>` : html;
  const shade = header
    ? '<w:shd w:val="clear" w:color="auto" w:fill="F2F4F8"/>'
    : '';
  return `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/>${shade}</w:tcPr>`
    + `<w:p><w:pPr><w:spacing w:line="280" w:lineRule="auto"/></w:pPr>${inlineRuns(content)}</w:p></w:tc>`;
}

/**
 * One table block as a real Word table.
 *
 * The first row is the header row: bold, shaded and repeated when the table
 * breaks across pages. A trailing empty paragraph keeps Word (and Word Online)
 * from merging the table into whatever follows it.
 */
function tableXml(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return '<w:p/>';
  const columns = Math.max(...rows.map((row) => row.length));
  const grid = columns > 0
    ? `<w:tblGrid>${Array.from({ length: columns }, () => '<w:gridCol w:w="0"/>').join('')}</w:tblGrid>`
    : '';
  const body = rows.map((row, index) => {
    const header = index === 0;
    const trPr = header ? '<w:trPr><w:tblHeader/></w:trPr>' : '';
    const cells = Array.from({ length: columns }, (_unused, column) => tableCell(String(row[column] ?? ''), header)).join('');
    return `<w:tr>${trPr}${cells}</w:tr>`;
  }).join('');
  const borders = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
    .map((side) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="BFC5D2"/>`)
    .join('');
  const table = `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>${borders}</w:tblBorders><w:tblLayout w:type="autofit"/></w:tblPr>${grid}${body}</w:tbl>`;
  return `${table}<w:p/>`;
}

/**
 * One image block as an inline drawing.
 * @param block - image block with `width` percent and intrinsic `px`/`py`.
 * @param relationshipId - the `rId` that links the media part.
 */
function imageXml(block, relationshipId) {
  const px = Number.isFinite(block.px) && block.px > 0 ? block.px : FALLBACK_PX;
  const py = Number.isFinite(block.py) && block.py > 0 ? block.py : FALLBACK_PY;
  const percent = Number.isFinite(block.width) ? Math.min(Math.max(block.width, 15), 100) : 100;
  const scale = Math.min((MAX_IMAGE_EMU * percent) / 100 / (px * EMU_PER_PX), 1);
  const cx = Math.round(px * EMU_PER_PX * scale);
  const cy = Math.round(py * EMU_PER_PX * scale);
  const drawing = '<w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">'
    + `<wp:extent cx="${cx}" cy="${cy}"/>`
    + '<wp:effectExtent l="0" t="0" r="0" b="0"/>'
    + '<wp:docPr id="1" name="Picture"/>'
    + '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">'
    + '<pic:pic><pic:nvPicPr><pic:cNvPr id="1" name="image"/><pic:cNvPicPr/></pic:nvPicPr>'
    + '<pic:blipFill><a:blip r:embed="' + relationshipId + '"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>'
    + `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>`
    + '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>';
  return `<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="120" w:after="120"/></w:pPr><w:r>${drawing}</w:r></w:p>`;
}

/** `word/document.xml`. */
function documentXml(body) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W_NS}" xmlns:r="${R_NS}" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="851" w:footer="992" w:gutter="0"/><w:cols w:space="425"/><w:docGrid w:linePitch="312"/></w:sectPr></w:body></w:document>`;
}

/** `word/styles.xml`. */
function stylesXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="${W_NS}">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="宋体" w:cs="Times New Roman"/><w:sz w:val="24"/><w:szCs w:val="24"/><w:lang w:val="en-US" w:eastAsia="zh-CN"/></w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:line="360" w:lineRule="auto"/><w:jc w:val="both"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:line="360" w:lineRule="auto"/><w:jc w:val="both"/></w:pPr><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="宋体"/><w:sz w:val="24"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:before="360" w:after="240" w:line="480" w:lineRule="auto"/><w:jc w:val="center"/></w:pPr><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="黑体"/><w:b/><w:sz w:val="44"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="360" w:after="180" w:line="360" w:lineRule="auto"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="黑体"/><w:b/><w:sz w:val="32"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="280" w:after="140" w:line="360" w:lineRule="auto"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="黑体"/><w:b/><w:sz w:val="28"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120" w:line="360" w:lineRule="auto"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="黑体"/><w:b/><w:sz w:val="26"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="720"/><w:spacing w:before="120" w:after="120"/></w:pPr><w:rPr><w:color w:val="555555"/><w:i/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F5F5F5"/><w:spacing w:before="120" w:after="120" w:line="260" w:lineRule="auto"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="Consolas"/><w:sz w:val="20"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="60"/></w:pPr></w:style>
<w:style w:type="character" w:styleId="CodeChar"><w:name w:val="Code Char"/><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="Consolas"/><w:sz w:val="20"/></w:rPr></w:style>
</w:styles>`;
}

/** `word/numbering.xml`: one bullet list and one decimal list. */
function numberingXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="${W_NS}">
<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="420" w:hanging="420"/></w:pPr><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="宋体"/></w:rPr></w:lvl></w:abstractNum>
<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="420" w:hanging="420"/></w:pPr></w:lvl></w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
</w:numbering>`;
}

/** `word/settings.xml`. */
function settingsXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings xmlns:w="${W_NS}"><w:zoom w:percent="100"/><w:defaultTabStop w:val="420"/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>`;
}

/** Content-types part. `images` is the set of media extensions in use. */
function contentTypesXml(images) {
  const defaults = [...images]
    .map((ext) => `<Default Extension="${ext}" ContentType="image/${ext === 'jpg' ? 'jpeg' : ext}"/>`)
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
${defaults}
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`;
}

/** Package relationships. */
function rootRelsXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;
}

/** Document relationships, including one per embedded image. */
function documentRelsXml(images) {
  const media = images
    .map((image) => `<Relationship Id="${image.rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${image.target}"/>`)
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>
${media}
</Relationships>`;
}

/** Core properties. */
function coreXml(title, createdAt) {
  const stamp = new Date(createdAt ?? Date.now()).toISOString().replace(/\.\d{3}Z$/, 'Z');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>${xml(title)}</dc:title><dc:creator>DeepSeek Harness · 协作文档</dc:creator><cp:lastModifiedBy>DeepSeek Harness</cp:lastModifiedBy>
<dcterms:created xsi:type="dcterms:W3CDTF">${stamp}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${stamp}</dcterms:modified>
</cp:coreProperties>`;
}

/** Extended properties. */
function appXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>DeepSeek Harness</Application></Properties>`;
}

/** Build a ZIP archive from named UTF-8 parts. */
function zip(parts) {
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;
  for (const part of parts) {
    const name = Buffer.from(part.name, 'utf8');
    const data = Buffer.isBuffer(part.data) ? part.data : Buffer.from(part.data, 'utf8');
    const compressed = deflateRawSync(data);
    const checksum = crc32(data) >>> 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localChunks.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralChunks.push(central, name);

    offset += local.length + name.length + compressed.length;
  }
  const centralSize = centralChunks.reduce((total, chunk) => total + chunk.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(parts.length, 8);
  end.writeUInt16LE(parts.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localChunks, ...centralChunks, end]);
}

/**
 * Build a .docx buffer.
 * @param options.title - document title.
 * @param options.blocks - stored blocks.
 * @param options.createdAt - creation timestamp for core properties.
 * @param options.resolveAsset - `src => { data, ext } | undefined`, used to embed
 *   the images a document stores; unresolved images are skipped, never fetched.
 * @returns the complete DOCX file.
 */
export function buildDocx({ title, blocks, createdAt, resolveAsset }) {
  const images = [];
  const extensions = new Set();
  let rid = 4;
  const body = blocks.map((block) => {
    if (block.type === 'table') return tableXml(block.rows ?? []);
    if (block.type === 'image') {
      const asset = typeof resolveAsset === 'function' ? resolveAsset(block.src) : undefined;
      if (asset === undefined || asset === null || !Buffer.isBuffer(asset.data)) return '';
      const relationshipId = `rId${rid}`;
      rid += 1;
      const target = `media/image${images.length + 1}.${asset.ext}`;
      images.push({ rid: relationshipId, target, data: asset.data });
      extensions.add(asset.ext);
      return imageXml(block, relationshipId);
    }
    return paragraph(block);
  }).join('');
  const parts = [
    { name: '[Content_Types].xml', data: contentTypesXml(extensions) },
    { name: '_rels/.rels', data: rootRelsXml() },
    { name: 'docProps/core.xml', data: coreXml(title, createdAt) },
    { name: 'docProps/app.xml', data: appXml() },
    { name: 'word/document.xml', data: documentXml(body.length > 0 ? body : '<w:p/>') },
    { name: 'word/styles.xml', data: stylesXml() },
    { name: 'word/numbering.xml', data: numberingXml() },
    { name: 'word/settings.xml', data: settingsXml() },
    { name: 'word/_rels/document.xml.rels', data: documentRelsXml(images) },
  ];
  for (const image of images) {
    parts.push({ name: `word/${image.target}`, data: image.data });
  }
  return zip(parts);
}

/** Plain-text export. */
export function buildText({ blocks }) {
  return blocks.map((block) => (block.type === 'table'
    ? (block.rows ?? []).map((row) => row.join(' | ')).join('\n')
    : htmlToText(block.html))).join('\n\n');
}

/** Debug helper used by the smoke test: the document body as plain paragraphs. */
export function documentText(blocks) {
  return blocks.map((block) => htmlToText(block.html));
}
