import type { AnalysisReport } from '../types';

const escapeHtml = (value: unknown): string => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** A self-contained report: no scripts, remote images, or external stylesheets. */
export function createAnalysisReportHtml(report: AnalysisReport): string {
  const text = escapeHtml;
  const charts = (report.charts || []).map(chart => {
    const image = chart.image && /^data:image\/(png|jpeg|webp);base64,[a-z0-9+/=\s]+$/i.test(chart.image)
      ? `<img src="${text(chart.image)}" alt="${text(chart.title)}">`
      : '<p class="muted">Chart image unavailable in this export.</p>';
    return `<figure><h3>${text(chart.title)}</h3>${image}${chart.caption ? `<figcaption>${text(chart.caption)}</figcaption>` : ''}</figure>`;
  }).join('');
  const tables = (report.tables || []).map(table => `<article><h3>${text(table.title)}</h3>
    ${table.caption ? `<p>${text(table.caption)}</p>` : ''}
    <div class="table-wrap"><table><thead><tr>${table.columns.map(column => `<th scope="col">${text(column)}</th>`).join('')}</tr></thead>
    <tbody>${table.rows.map(row => `<tr>${row.map(cell => `<td>${text(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div></article>`).join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>${text(report.title || 'Dataset analysis report')}</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#f5f4f0;color:#262a30;font:16px/1.65 Georgia,serif}main{max-width:1000px;margin:40px auto;padding:48px;background:#fff;border-top:5px solid #466c87}header{border-bottom:1px solid #deded8;padding-bottom:24px}h1{font-size:36px;line-height:1.2;margin:12px 0}h2{font-size:25px;margin:36px 0 16px}h3{font-size:19px;margin:12px 0}p,li,figcaption{white-space:pre-wrap;overflow-wrap:anywhere}.eyebrow,.muted,figcaption,footer{color:#626b75}.eyebrow{font:12px/1.6 sans-serif;letter-spacing:2px;text-transform:uppercase}.metric{font:600 24px/1.4 sans-serif;color:#355c75}.insight{border-left:3px solid #b5c6ce;padding:4px 20px;margin:20px 0}figure{margin:24px 0}img{display:block;max-width:100%;height:auto}figcaption{font-size:14px;margin-top:8px}.table-wrap{overflow-x:auto}table{width:100%;border-collapse:collapse;font:14px/1.5 sans-serif;margin:12px 0 24px}th,td{padding:10px;text-align:left;border-bottom:1px solid #deded8;white-space:pre-wrap;overflow-wrap:anywhere}th{background:#eef2f3}footer{margin-top:40px;border-top:1px solid #deded8;padding-top:16px;font-size:13px}@media(max-width:640px){main{margin:0;padding:24px}h1{font-size:28px}}@media print{body{background:white}main{margin:0;padding:0;border:0;max-width:none}h2,h3{break-after:avoid}img,tr,.insight{break-inside:avoid}thead{display:table-header-group}.table-wrap{overflow:visible}}
</style></head><body><main><header><div class="eyebrow">Dataset analysis report</div>
<h1>${text(report.title || 'Dataset analysis')}</h1><p><strong>Dataset:</strong> ${text(report.dataset_name)}</p>
${report.generated_at ? `<p class="muted">Generated: ${text(report.generated_at)}</p>` : ''}
${report.question ? `<p><strong>Analysis question:</strong> ${text(report.question)}</p>` : ''}</header>
<section><h2>Executive summary</h2><p>${text(report.executive_summary)}</p></section>
${report.insights?.length ? `<section><h2>Key findings</h2>${report.insights.map(insight => `<article class="insight"><h3>${text(insight.title)}</h3>${insight.metric || insight.value ? `<p class="metric">${text(insight.metric)}${insight.metric && insight.value ? ': ' : ''}${text(insight.value)}</p>` : ''}<p>${text(insight.detail)}</p></article>`).join('')}</section>` : ''}
${charts ? `<section><h2>Charts</h2>${charts}</section>` : ''}
${tables ? `<section><h2>Supporting data</h2>${tables}</section>` : ''}
${report.recommendations?.length ? `<section><h2>Recommendations</h2><ol>${report.recommendations.map(item => `<li>${text(item)}</li>`).join('')}</ol></section>` : ''}
${report.methodology ? `<section><h2>Methodology</h2><p>${text(report.methodology)}</p></section>` : ''}
<footer>This report contains the analysis results and supporting tables supplied by the dashboard. It does not include the full source dataset.</footer>
</main></body></html>`;
}

export function downloadAnalysisReport(report: AnalysisReport): void {
  const url = URL.createObjectURL(new Blob([createAnalysisReportHtml(report)], { type: 'text/html;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `${(report.dataset_name || 'dataset').replace(/[^a-z0-9_-]/gi, '_')}_analysis_report.html`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
