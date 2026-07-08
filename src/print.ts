import {
	App,
	Component,
	MarkdownRenderer,
	Notice,
	Platform,
	TFile,
	arrayBufferToBase64,
} from "obsidian";
import { jsPDF } from "jspdf";

// Prints a note. On desktop the rendered note is loaded into a hidden iframe
// and sent to the system print dialog. On mobile window.print() is a no-op
// inside the webview, so the note is converted to a text-based PDF (jsPDF,
// no rasterization) and handed to the native share sheet — iOS/Android offer
// Print, AirPrint, Save to Files, etc. for a PDF.
export async function printNote(app: App, file: TFile): Promise<void> {
	const markdown = await app.vault.cachedRead(file);

	// Render through Obsidian so wikilinks, embeds, callouts and other
	// post-processors are resolved. The host is attached off-screen because
	// some renderers require a live document.
	const host = activeDocument.body.createDiv();
	host.addClass("markdown-rendered");
	host.setCssStyles({
		position: "absolute",
		left: "-10000px",
		top: "0",
		width: "700px",
	});
	const component = new Component();
	component.load();

	try {
		await MarkdownRenderer.render(app, markdown, host, file.path, component);
		if (Platform.isMobile) {
			await shareAsPdf(app, file, host);
		} else {
			await printViaIframe(file.basename, host);
		}
	} finally {
		component.unload();
		host.remove();
	}
}

// --- Desktop: hidden iframe + system print dialog ---

const PRINT_CSS = `
@page { margin: 18mm; }
body {
	font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
	font-size: 12pt;
	line-height: 1.5;
	color: #111;
	margin: 0;
}
.print-title { font-size: 20pt; margin: 0 0 0.6em; padding-bottom: 0.3em; border-bottom: 1px solid #ccc; }
h1 { font-size: 17pt; } h2 { font-size: 15pt; } h3 { font-size: 13pt; }
h4, h5, h6 { font-size: 12pt; }
h1, h2, h3, h4, h5, h6 { page-break-after: avoid; margin: 1em 0 0.4em; }
p { margin: 0.4em 0; }
code {
	font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
	font-size: 10pt;
	background: #f5f5f5;
	padding: 1px 3px;
	border-radius: 3px;
}
pre {
	background: #f5f5f5;
	padding: 8px;
	border-radius: 4px;
	white-space: pre-wrap;
	word-wrap: break-word;
	page-break-inside: avoid;
}
pre code { background: none; padding: 0; }
blockquote { border-left: 3px solid #ccc; margin: 0.5em 0; padding: 0 0 0 12px; color: #444; page-break-inside: avoid; }
img { max-width: 100%; page-break-inside: avoid; }
table { border-collapse: collapse; page-break-inside: avoid; }
th, td { border: 1px solid #bbb; padding: 4px 8px; text-align: left; }
th { background: #f0f0f0; }
a { color: #1a6dcc; text-decoration: none; }
hr { border: none; border-top: 1px solid #ccc; }
ul.contains-task-list { list-style: none; padding-left: 1.2em; }
input[type="checkbox"] { margin-right: 6px; }
.callout { border-left: 3px solid #888; background: #f7f7f7; padding: 8px 12px; margin: 0.5em 0; border-radius: 4px; }
.callout-title { font-weight: 600; }
.copy-code-button, .edit-block-button, .collapse-indicator,
.frontmatter, .frontmatter-container, .metadata-container, .mod-frontmatter { display: none !important; }
`;

async function printViaIframe(title: string, host: HTMLElement): Promise<void> {
	for (const old of Array.from(
		activeDocument.querySelectorAll(".mobile-explorer-print-frame")
	)) {
		old.remove();
	}
	const iframe = activeDocument.body.createEl("iframe", {
		cls: "mobile-explorer-print-frame",
	});
	iframe.setCssStyles({
		position: "fixed",
		right: "0",
		bottom: "0",
		width: "0",
		height: "0",
		border: "none",
	});
	const idoc = iframe.contentDocument;
	const iwin = iframe.contentWindow;
	if (!idoc || !iwin) {
		iframe.remove();
		new Notice("Could not open the print dialog");
		return;
	}

	idoc.title = title;
	const style = idoc.createElement("style");
	style.textContent = PRINT_CSS;
	idoc.head.appendChild(style);

	const heading = idoc.createElement("h1");
	heading.className = "print-title";
	heading.textContent = title;
	idoc.body.appendChild(heading);
	for (const child of Array.from(host.childNodes)) {
		idoc.body.appendChild(idoc.importNode(child, true));
	}

	await waitForImages(idoc);
	iwin.addEventListener("afterprint", () => iframe.remove());
	iwin.focus();
	iwin.print();
}

async function waitForImages(doc: Document): Promise<void> {
	const pending = Array.from(doc.images).filter((img) => !img.complete);
	if (pending.length === 0) return;
	await Promise.race([
		Promise.all(
			pending.map(
				(img) =>
					new Promise<void>((resolve) => {
						img.addEventListener("load", () => resolve(), { once: true });
						img.addEventListener("error", () => resolve(), { once: true });
					})
			)
		),
		new Promise<void>((resolve) => window.setTimeout(resolve, 3000)),
	]);
}

// --- Mobile: PDF + native share sheet ---

async function shareAsPdf(
	app: App,
	file: TFile,
	host: HTMLElement
): Promise<void> {
	const notice = new Notice("Preparing PDF…", 0);
	let blob: Blob;
	try {
		const writer = new PdfWriter();
		writer.drawTitle(file.basename);
		const renderer = new NoteRenderer(app, writer, file.path);
		await renderer.renderBlocks(host, { indent: 0, quoteDepth: 0 });
		writer.finish();
		blob = writer.doc.output("blob");
	} finally {
		notice.hide();
	}

	const pdfName = `${file.basename}.pdf`;
	const pdfFile = new File([blob], pdfName, { type: "application/pdf" });
	const nav = navigator as Navigator & {
		canShare?: (data: { files: File[] }) => boolean;
	};
	if (
		typeof nav.share === "function" &&
		(!nav.canShare || nav.canShare({ files: [pdfFile] }))
	) {
		try {
			await nav.share({ files: [pdfFile], title: file.basename });
			return;
		} catch (e) {
			// The user closing the share sheet is not an error.
			if (e instanceof Error && e.name === "AbortError") return;
		}
	}

	// Fallback (e.g. webviews without the Web Share API): save the PDF into
	// the vault next to the note and open it.
	const dir =
		file.parent && file.parent.path !== "/" ? file.parent.path + "/" : "";
	let path = `${dir}${file.basename}.pdf`;
	let counter = 1;
	while (app.vault.getAbstractFileByPath(path)) {
		counter++;
		path = `${dir}${file.basename} ${counter}.pdf`;
	}
	const saved = await app.vault.createBinary(path, await blob.arrayBuffer());
	new Notice(`Sharing isn't available — saved PDF to "${path}"`);
	await app.workspace.getLeaf(false).openFile(saved);
}

// --- PDF layout ---

const MARGIN = 54; // 0.75in
const BODY_SIZE = 11;
const CODE_SIZE = 9;
const TABLE_SIZE = 10;
const LINE_FACTOR = 1.45;
const LIST_INDENT = 18;
const QUOTE_INDENT = 14;
const HEADING_SIZES = [22, 18, 15, 13, 12, 11];
const TEXT_COLOR: [number, number, number] = [17, 17, 17];
const MUTED_COLOR: [number, number, number] = [110, 110, 110];
const LINK_COLOR: [number, number, number] = [26, 109, 204];

interface Span {
	text: string;
	bold: boolean;
	italic: boolean;
	code: boolean;
	strike: boolean;
	href: string | null;
}

interface LinePart {
	span: Span;
	text: string;
	width: number;
}

interface Line {
	parts: LinePart[];
	width: number;
}

interface BlockCtx {
	indent: number;
	quoteDepth: number;
}

function makeSpan(text: string, style: Partial<Span> = {}): Span {
	return {
		text,
		bold: style.bold ?? false,
		italic: style.italic ?? false,
		code: style.code ?? false,
		strike: style.strike ?? false,
		href: style.href ?? null,
	};
}

// The PDF uses the 14 built-in fonts, which cover WinAnsi (Latin-1 plus
// common typographic punctuation). Anything else would render as mojibake,
// so common symbols are transliterated, invisible/emoji characters dropped,
// and the rest replaced with "?".
const WINANSI_EXTRAS = new Set(
	"€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ"
);
const CHAR_MAP: Record<string, string> = {
	"→": "->",
	"←": "<-",
	"↔": "<->",
	"⇒": "=>",
	"⇐": "<=",
	"−": "-",
	"‐": "-",
	"‑": "-",
	"―": "-",
	"✓": "x",
	"✔": "x",
	"✗": "x",
	"✘": "x",
	"●": "•",
	"▪": "•",
	"◦": "•",
	"∙": "•",
	"\u2028": "\n",
	"\u2029": "\n",
};

function sanitize(text: string): string {
	let out = "";
	for (const ch of text) {
		const cp = ch.codePointAt(0) ?? 0;
		if (ch === "\t") {
			out += "    ";
			continue;
		}
		if (cp === 0xa0) {
			out += " ";
			continue;
		}
		if (cp < 0x100 || WINANSI_EXTRAS.has(ch)) {
			out += ch;
			continue;
		}
		const mapped = CHAR_MAP[ch];
		if (mapped !== undefined) {
			out += mapped;
			continue;
		}
		if (cp === 0x200b || cp === 0x200c || cp === 0x200d || cp === 0xfeff)
			continue;
		if ((cp >= 0xfe00 && cp <= 0xfe0f) || cp >= 0x1f000) continue;
		if (cp >= 0x2190 && cp <= 0x2bff) continue; // arrows/symbols/dingbats
		out += "?";
	}
	return out;
}

export class PdfWriter {
	readonly doc: jsPDF;
	readonly margin = MARGIN;
	readonly pageW: number;
	readonly pageH: number;
	y: number;

	constructor() {
		this.doc = new jsPDF({ unit: "pt", format: "letter", compress: true });
		this.pageW = this.doc.internal.pageSize.getWidth();
		this.pageH = this.doc.internal.pageSize.getHeight();
		this.y = this.margin;
	}

	get usableW(): number {
		return this.pageW - 2 * this.margin;
	}

	get maxY(): number {
		return this.pageH - this.margin;
	}

	ensureRoom(height: number): void {
		if (this.y + height > this.maxY && this.y > this.margin) {
			this.doc.addPage();
			this.y = this.margin;
		}
	}

	// Vertical whitespace; suppressed at the top of a page.
	space(height: number): void {
		if (this.y > this.margin) this.y = Math.min(this.y + height, this.maxY);
	}

	applyFont(style: Partial<Span>, size: number): void {
		const variant =
			style.bold && style.italic
				? "bolditalic"
				: style.bold
					? "bold"
					: style.italic
						? "italic"
						: "normal";
		this.doc.setFont(style.code ? "courier" : "helvetica", variant);
		this.doc.setFontSize(size);
	}

	measure(text: string, style: Partial<Span>, size: number): number {
		this.applyFont(style, size);
		return this.doc.getTextWidth(text);
	}

	// Greedy word-wrap across style spans. preserveWhitespace keeps leading
	// spaces (needed for code indentation).
	wrap(
		spans: Span[],
		width: number,
		size: number,
		preserveWhitespace = false
	): Line[] {
		const lines: Line[] = [];
		let cur: Line = { parts: [], width: 0 };
		const flush = () => {
			lines.push(cur);
			cur = { parts: [], width: 0 };
		};
		const append = (span: Span, text: string, w: number) => {
			const last = cur.parts[cur.parts.length - 1];
			if (last && last.span === span) {
				last.text += text;
				last.width += w;
			} else {
				cur.parts.push({ span, text, width: w });
			}
			cur.width += w;
		};

		for (const span of spans) {
			for (const token of span.text.split(/(\n|[ ]+)/)) {
				if (!token) continue;
				if (token === "\n") {
					flush();
					continue;
				}
				const isSpace = token.trim().length === 0;
				if (isSpace && cur.parts.length === 0 && !preserveWhitespace)
					continue;
				const w = this.measure(token, span, size);
				if (!isSpace && cur.width > 0 && cur.width + w > width) flush();
				if (!isSpace && w > width) {
					// Hard-break a word that is wider than the line.
					let rest = token;
					while (rest) {
						let n = 1;
						while (
							n < rest.length &&
							this.measure(rest.slice(0, n + 1), span, size) <= width
						) {
							n++;
						}
						const chunk = rest.slice(0, n);
						append(span, chunk, this.measure(chunk, span, size));
						rest = rest.slice(n);
						if (rest) flush();
					}
					continue;
				}
				append(span, token, w);
			}
		}
		if (cur.parts.length > 0) lines.push(cur);
		return lines;
	}

	drawLineAt(
		line: Line,
		x: number,
		top: number,
		size: number,
		lineHeight: number,
		color: [number, number, number]
	): void {
		let cx = x;
		const baseline = top + size * 0.95;
		for (const part of line.parts) {
			this.applyFont(part.span, size);
			const c = part.span.href ? LINK_COLOR : color;
			this.doc.setTextColor(c[0], c[1], c[2]);
			this.doc.text(part.text, cx, baseline);
			if (part.span.href) {
				this.doc.link(cx, top, part.width, lineHeight, {
					url: part.span.href,
				});
			}
			if (part.span.strike) {
				this.doc.setDrawColor(c[0], c[1], c[2]);
				this.doc.setLineWidth(0.6);
				this.doc.line(
					cx,
					baseline - size * 0.3,
					cx + part.width,
					baseline - size * 0.3
				);
			}
			cx += part.width;
		}
	}

	drawLines(
		lines: Line[],
		opts: {
			x: number;
			size: number;
			color?: [number, number, number];
			bars?: number[];
		}
	): void {
		const lineHeight = opts.size * LINE_FACTOR;
		for (const line of lines) {
			this.ensureRoom(lineHeight);
			if (opts.bars) {
				this.doc.setDrawColor(200);
				this.doc.setLineWidth(2);
				for (const bx of opts.bars) {
					this.doc.line(bx, this.y, bx, this.y + lineHeight);
				}
			}
			this.drawLineAt(
				line,
				opts.x,
				this.y,
				opts.size,
				lineHeight,
				opts.color ?? TEXT_COLOR
			);
			this.y += lineHeight;
		}
	}

	drawTitle(title: string): void {
		const size = 20;
		const lines = this.wrap(
			[makeSpan(sanitize(title), { bold: true })],
			this.usableW,
			size
		);
		this.drawLines(lines, { x: this.margin, size });
		this.y += 2;
		this.doc.setDrawColor(200);
		this.doc.setLineWidth(0.75);
		this.doc.line(this.margin, this.y, this.pageW - this.margin, this.y);
		this.y += 14;
	}

	finish(): void {
		const total = this.doc.getNumberOfPages();
		if (total < 2) return;
		for (let i = 1; i <= total; i++) {
			this.doc.setPage(i);
			this.applyFont({}, 9);
			this.doc.setTextColor(130, 130, 130);
			this.doc.text(`${i} / ${total}`, this.pageW / 2, this.pageH - 24, {
				align: "center",
			});
		}
	}
}

export class NoteRenderer {
	constructor(
		private app: App,
		private w: PdfWriter,
		private sourcePath: string
	) {}

	async renderBlocks(el: HTMLElement, ctx: BlockCtx): Promise<void> {
		for (const child of Array.from(el.children)) {
			if (!child.instanceOf(HTMLElement)) continue; // svg, MathML, …
			await this.renderBlock(child, ctx);
		}
	}

	private isSkipped(el: HTMLElement): boolean {
		const cls = el.classList;
		return (
			el.tagName === "STYLE" ||
			el.tagName === "SCRIPT" ||
			el.tagName === "BUTTON" ||
			cls.contains("frontmatter") ||
			cls.contains("frontmatter-container") ||
			cls.contains("metadata-container") ||
			cls.contains("mod-frontmatter") ||
			cls.contains("edit-block-button") ||
			cls.contains("copy-code-button") ||
			cls.contains("markdown-embed-link") ||
			cls.contains("collapse-indicator")
		);
	}

	private async renderBlock(el: HTMLElement, ctx: BlockCtx): Promise<void> {
		if (this.isSkipped(el)) return;
		const tag = el.tagName;
		if (/^H[1-6]$/.test(tag)) {
			this.heading(el, ctx, Number(tag[1]));
			return;
		}
		switch (tag) {
			case "P":
				await this.paragraph(el, ctx);
				return;
			case "UL":
			case "OL":
				await this.list(el, ctx);
				return;
			case "PRE":
				this.codeBlock(el, ctx);
				return;
			case "BLOCKQUOTE":
				await this.blockquote(el, ctx);
				return;
			case "TABLE":
				this.table(el, ctx);
				return;
			case "HR":
				this.rule(ctx);
				return;
			case "IMG":
				await this.image(el as HTMLImageElement, ctx);
				return;
			case "CANVAS":
				return;
		}
		if (el.classList.contains("callout")) {
			await this.callout(el, ctx);
			return;
		}
		if (el.children.length > 0) {
			await this.renderBlocks(el, ctx);
		} else if (el.textContent && el.textContent.trim()) {
			await this.paragraph(el, ctx);
		}
	}

	private barsFor(ctx: BlockCtx): number[] | undefined {
		if (ctx.quoteDepth === 0) return undefined;
		const bars: number[] = [];
		for (let d = 1; d <= ctx.quoteDepth; d++) {
			bars.push(
				this.w.margin +
					ctx.indent -
					(ctx.quoteDepth - d + 1) * QUOTE_INDENT +
					3
			);
		}
		return bars;
	}

	private collectInline(
		root: HTMLElement,
		style: Partial<Span> = {},
		exclude?: Set<string>
	): { spans: Span[]; images: HTMLImageElement[] } {
		const spans: Span[] = [];
		const images: HTMLImageElement[] = [];
		const walk = (node: Node, s: Span) => {
			if (node.nodeType === Node.TEXT_NODE) {
				// Newlines in HTML text collapse to spaces; only <br> breaks.
				const text = sanitize(node.textContent ?? "").replace(
					/[\r\n]+/g,
					" "
				);
				if (text) spans.push({ ...s, text });
				return;
			}
			if (!node.instanceOf(HTMLElement)) return;
			if (this.isSkipped(node)) return;
			const tag = node.tagName;
			if (exclude?.has(tag)) return;
			if (tag === "BR") {
				spans.push({ ...s, text: "\n" });
				return;
			}
			if (tag === "IMG") {
				images.push(node as HTMLImageElement);
				return;
			}
			if (tag === "INPUT") return;
			const next = { ...s };
			if (tag === "STRONG" || tag === "B") next.bold = true;
			else if (tag === "EM" || tag === "I") next.italic = true;
			else if (tag === "CODE") next.code = true;
			else if (tag === "DEL" || tag === "S") next.strike = true;
			else if (tag === "A") {
				const href = node.getAttribute("href") ?? "";
				next.href = /^https?:\/\//.test(href) ? href : null;
			}
			for (const child of Array.from(node.childNodes)) walk(child, next);
		};
		for (const child of Array.from(root.childNodes)) {
			walk(child, makeSpan("", style));
		}
		return { spans, images };
	}

	private heading(el: HTMLElement, ctx: BlockCtx, level: number): void {
		const size = HEADING_SIZES[level - 1];
		const { spans } = this.collectInline(el, { bold: true });
		const lines = this.w.wrap(spans, this.w.usableW - ctx.indent, size);
		this.w.space(size * 0.9);
		this.w.drawLines(lines, {
			x: this.w.margin + ctx.indent,
			size,
			bars: this.barsFor(ctx),
		});
		this.w.space(size * 0.35);
	}

	private async paragraph(
		el: HTMLElement,
		ctx: BlockCtx,
		size = BODY_SIZE
	): Promise<void> {
		const { spans, images } = this.collectInline(el);
		if (spans.some((s) => s.text.trim().length > 0)) {
			const lines = this.w.wrap(spans, this.w.usableW - ctx.indent, size);
			this.w.drawLines(lines, {
				x: this.w.margin + ctx.indent,
				size,
				bars: this.barsFor(ctx),
			});
			this.w.space(size * 0.6);
		}
		for (const img of images) await this.image(img, ctx);
	}

	private async list(el: HTMLElement, ctx: BlockCtx): Promise<void> {
		const ordered = el.tagName === "OL";
		let index = Number(el.getAttribute("start") ?? "1");
		if (Number.isNaN(index)) index = 1;
		for (const li of Array.from(el.children)) {
			if (!li.instanceOf(HTMLElement) || li.tagName !== "LI") continue;
			await this.listItem(li, ctx, ordered ? index : null);
			index++;
		}
		this.w.space(4);
	}

	private async listItem(
		li: HTMLElement,
		ctx: BlockCtx,
		index: number | null
	): Promise<void> {
		const w = this.w;
		const size = BODY_SIZE;
		const lineHeight = size * LINE_FACTOR;
		const { spans, images } = this.collectInline(
			li,
			{},
			new Set(["UL", "OL"])
		);
		const markerX = w.margin + ctx.indent;
		const textX = markerX + LIST_INDENT;
		const lines = w.wrap(spans, w.usableW - ctx.indent - LIST_INDENT, size);

		w.ensureRoom(lineHeight);
		const isTask = li.classList.contains("task-list-item");
		if (isTask) {
			const checked =
				li.classList.contains("is-checked") ||
				li.querySelector("input")?.checked === true;
			const box = size * 0.7;
			const by = w.y + (lineHeight - box) / 2 - 1;
			w.doc.setDrawColor(120, 120, 120);
			w.doc.setLineWidth(0.8);
			w.doc.rect(markerX + 1, by, box, box);
			if (checked) {
				w.doc.line(
					markerX + 1 + box * 0.2,
					by + box * 0.55,
					markerX + 1 + box * 0.45,
					by + box * 0.8
				);
				w.doc.line(
					markerX + 1 + box * 0.45,
					by + box * 0.8,
					markerX + 1 + box * 0.85,
					by + box * 0.2
				);
			}
		} else if (index !== null) {
			w.applyFont({}, size);
			w.doc.setTextColor(TEXT_COLOR[0], TEXT_COLOR[1], TEXT_COLOR[2]);
			w.doc.text(`${index}.`, markerX, w.y + size * 0.95);
		} else {
			w.applyFont({ bold: true }, size);
			w.doc.setTextColor(TEXT_COLOR[0], TEXT_COLOR[1], TEXT_COLOR[2]);
			w.doc.text("•", markerX + 3, w.y + size * 0.95);
		}

		if (lines.length > 0) {
			w.drawLines(lines, { x: textX, size, bars: this.barsFor(ctx) });
		} else {
			w.y += lineHeight;
		}
		w.space(2);

		const childCtx: BlockCtx = { ...ctx, indent: ctx.indent + LIST_INDENT };
		for (const img of images) await this.image(img, childCtx);
		for (const sub of Array.from(li.children)) {
			if (
				sub.instanceOf(HTMLElement) &&
				(sub.tagName === "UL" || sub.tagName === "OL")
			) {
				await this.list(sub, childCtx);
			}
		}
	}

	private codeBlock(el: HTMLElement, ctx: BlockCtx): void {
		const w = this.w;
		const size = CODE_SIZE;
		const lineHeight = size * 1.4;
		const raw = (el.querySelector("code") ?? el).textContent ?? "";
		const text = sanitize(raw.replace(/\n$/, ""));
		const bgX = w.margin + ctx.indent;
		const bgW = w.usableW - ctx.indent;
		const textXPad = 6;

		w.space(4);
		w.ensureRoom(lineHeight + 8);
		w.doc.setFillColor(245, 245, 245);
		w.doc.rect(bgX, w.y, bgW, 4, "F");
		w.y += 4;
		for (const src of text.split("\n")) {
			const lines: Line[] = src.length
				? w.wrap([makeSpan(src, { code: true })], bgW - 2 * textXPad, size, true)
				: [{ parts: [], width: 0 }];
			for (const line of lines) {
				w.ensureRoom(lineHeight);
				w.doc.setFillColor(245, 245, 245);
				w.doc.rect(bgX, w.y, bgW, lineHeight, "F");
				w.drawLineAt(line, bgX + textXPad, w.y, size, lineHeight, TEXT_COLOR);
				w.y += lineHeight;
			}
		}
		if (w.y + 4 <= w.maxY) {
			w.doc.setFillColor(245, 245, 245);
			w.doc.rect(bgX, w.y, bgW, 4, "F");
			w.y += 4;
		}
		w.space(8);
	}

	private async blockquote(el: HTMLElement, ctx: BlockCtx): Promise<void> {
		const inner: BlockCtx = {
			indent: ctx.indent + QUOTE_INDENT,
			quoteDepth: ctx.quoteDepth + 1,
		};
		await this.renderBlocks(el, inner);
		this.w.space(4);
	}

	private async callout(el: HTMLElement, ctx: BlockCtx): Promise<void> {
		const inner: BlockCtx = {
			indent: ctx.indent + QUOTE_INDENT,
			quoteDepth: ctx.quoteDepth + 1,
		};
		const title = sanitize(
			el.querySelector(".callout-title-inner")?.textContent?.trim() ?? ""
		);
		if (title) {
			const lines = this.w.wrap(
				[makeSpan(title, { bold: true })],
				this.w.usableW - inner.indent,
				BODY_SIZE
			);
			this.w.drawLines(lines, {
				x: this.w.margin + inner.indent,
				size: BODY_SIZE,
				bars: this.barsFor(inner),
			});
			this.w.space(3);
		}
		const content = el.querySelector(".callout-content");
		if (content && content.instanceOf(HTMLElement)) {
			await this.renderBlocks(content, inner);
		}
		this.w.space(4);
	}

	private table(el: HTMLElement, ctx: BlockCtx): void {
		const w = this.w;
		const size = TABLE_SIZE;
		const lineHeight = size * 1.35;
		const pad = 4;
		const rows = Array.from(el.querySelectorAll("tr"));
		if (rows.length === 0) return;
		const ncols = Math.max(...rows.map((r) => r.children.length));
		if (ncols === 0) return;
		const colW = (w.usableW - ctx.indent) / ncols;
		const x0 = w.margin + ctx.indent;

		w.space(4);
		for (const row of rows) {
			const cells = Array.from(row.children).filter(
				(c): c is HTMLElement => c.instanceOf(HTMLElement)
			);
			const isHeader = cells.some((c) => c.tagName === "TH");
			const cellLines = cells.map((c) => {
				const { spans } = this.collectInline(c, {
					bold: c.tagName === "TH",
				});
				return w.wrap(spans, colW - 2 * pad, size);
			});
			const nLines = Math.max(1, ...cellLines.map((l) => l.length));
			const rowH = nLines * lineHeight + 2 * pad;
			w.ensureRoom(rowH);
			if (isHeader) {
				w.doc.setFillColor(240, 240, 240);
				w.doc.rect(x0, w.y, colW * ncols, rowH, "F");
			}
			w.doc.setDrawColor(180, 180, 180);
			w.doc.setLineWidth(0.5);
			for (let i = 0; i < cells.length; i++) {
				w.doc.rect(x0 + i * colW, w.y, colW, rowH, "S");
				let ly = w.y + pad;
				for (const line of cellLines[i]) {
					w.drawLineAt(
						line,
						x0 + i * colW + pad,
						ly,
						size,
						lineHeight,
						TEXT_COLOR
					);
					ly += lineHeight;
				}
			}
			w.y += rowH;
		}
		w.space(8);
	}

	private rule(ctx: BlockCtx): void {
		const w = this.w;
		w.space(6);
		w.ensureRoom(10);
		w.doc.setDrawColor(200, 200, 200);
		w.doc.setLineWidth(0.75);
		w.doc.line(
			w.margin + ctx.indent,
			w.y + 4,
			w.pageW - w.margin,
			w.y + 4
		);
		w.y += 10;
	}

	private async image(img: HTMLImageElement, ctx: BlockCtx): Promise<void> {
		const w = this.w;
		const data = await this.resolveImage(img);
		if (data) {
			try {
				const props = w.doc.getImageProperties(data.dataUrl);
				// CSS px → pt
				let iw = props.width * 0.75;
				let ih = props.height * 0.75;
				const attrW = Number(img.getAttribute("width"));
				if (attrW > 0 && iw > 0) {
					ih *= (attrW * 0.75) / iw;
					iw = attrW * 0.75;
				}
				const maxW = w.usableW - ctx.indent;
				const maxH = w.pageH - 2 * w.margin - 20;
				const scale = Math.min(1, maxW / iw, maxH / ih);
				iw *= scale;
				ih *= scale;
				w.ensureRoom(ih);
				w.doc.addImage(
					data.dataUrl,
					data.format,
					w.margin + ctx.indent,
					w.y,
					iw,
					ih
				);
				w.y += ih;
				w.space(8);
				return;
			} catch {
				// fall through to the placeholder
			}
		}
		const label = sanitize(img.getAttribute("alt") || "image");
		const lines = w.wrap(
			[makeSpan(`[${label}]`, { italic: true })],
			w.usableW - ctx.indent,
			BODY_SIZE
		);
		w.drawLines(lines, {
			x: w.margin + ctx.indent,
			size: BODY_SIZE,
			color: MUTED_COLOR,
			bars: this.barsFor(ctx),
		});
		w.space(4);
	}

	private async resolveImage(
		img: HTMLImageElement
	): Promise<{ dataUrl: string; format: "PNG" | "JPEG" } | null> {
		const src = img.getAttribute("src") ?? "";
		if (src.startsWith("data:image/png")) {
			return { dataUrl: src, format: "PNG" };
		}
		if (
			src.startsWith("data:image/jpeg") ||
			src.startsWith("data:image/jpg")
		) {
			return { dataUrl: src, format: "JPEG" };
		}
		// Vault images: the embed wrapper carries the original link text.
		const embedSrc =
			img.closest(".internal-embed")?.getAttribute("src") ??
			(src && !src.includes("://") ? src : null);
		if (!embedSrc) return null;
		let linkText = embedSrc.split("#")[0].split("|")[0];
		try {
			linkText = decodeURIComponent(linkText);
		} catch {
			// keep as-is
		}
		const file = this.app.metadataCache.getFirstLinkpathDest(
			linkText,
			this.sourcePath
		);
		if (!file) return null;
		const ext = file.extension.toLowerCase();
		const format =
			ext === "png" ? "PNG" : ext === "jpg" || ext === "jpeg" ? "JPEG" : null;
		if (!format) return null;
		const buffer = await this.app.vault.readBinary(file);
		const mime = format === "PNG" ? "image/png" : "image/jpeg";
		return {
			dataUrl: `data:${mime};base64,${arrayBufferToBase64(buffer)}`,
			format,
		};
	}
}
