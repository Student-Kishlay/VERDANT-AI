// Report generation (Master Prompt §13). PDFs are simple text/table
// layouts — pdf-lib has no chart-rendering support, and pulling in
// something that does (e.g. node-canvas) means native binaries, a bad
// trade for a mock backend. Legible aligned columns in a fixed-width font
// are enough to satisfy "opens without corruption."
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import ExcelJS from 'exceljs';
import { computeKpis } from './compute-kpis.js';
import { forecastRevenue } from './forecast-revenue.js';
import { segmentCustomers } from './segment-customers.js';

const PAGE_MARGIN = 50;
const LINE_HEIGHT = 16;

async function newPdfWriter(title) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const boldFont = await doc.embedFont(StandardFonts.HelveticaBold);
  const mono = await doc.embedFont(StandardFonts.Courier);
  let page = doc.addPage();
  let y = page.getHeight() - PAGE_MARGIN;

  function ensureSpace() {
    if (y < PAGE_MARGIN) {
      page = doc.addPage();
      y = page.getHeight() - PAGE_MARGIN;
    }
  }

  return {
    doc,
    heading(text) {
      ensureSpace();
      page.drawText(text, { x: PAGE_MARGIN, y, size: 18, font: boldFont, color: rgb(0.04, 0.18, 0.14) });
      y -= LINE_HEIGHT * 1.8;
    },
    subheading(text) {
      ensureSpace();
      page.drawText(text, { x: PAGE_MARGIN, y, size: 12, font: boldFont, color: rgb(0.2, 0.2, 0.2) });
      y -= LINE_HEIGHT * 1.3;
    },
    text(text) {
      ensureSpace();
      page.drawText(text, { x: PAGE_MARGIN, y, size: 10, font, color: rgb(0.1, 0.1, 0.1) });
      y -= LINE_HEIGHT;
    },
    row(cells, widths) {
      ensureSpace();
      let x = PAGE_MARGIN;
      cells.forEach((cell, i) => {
        page.drawText(String(cell), { x, y, size: 9.5, font: mono, color: rgb(0.15, 0.15, 0.15) });
        x += widths[i];
      });
      y -= LINE_HEIGHT;
    },
    gap() {
      y -= LINE_HEIGHT * 0.5;
    },
    async save() {
      return doc.save();
    },
  };
}

async function buildAnalyticsSummary(dataset, columns, rows) {
  const kpis = computeKpis(columns, rows);
  const w = await newPdfWriter();
  w.heading('Analytics Summary');
  w.text(`${dataset.file_name} — generated ${new Date().toISOString()}`);
  w.gap();

  if (!kpis.available) {
    w.text(`Not enough data to compute KPIs — missing: ${kpis.missing.join(', ')}`);
  } else {
    w.subheading('Key Metrics');
    w.row(['Total Revenue', `$${kpis.total_revenue.toLocaleString()}`], [180, 200]);
    w.row(['Total Orders', String(kpis.total_orders)], [180, 200]);
    w.row(['Average Order Value', `$${kpis.avg_order_value.toLocaleString()}`], [180, 200]);
    w.row(['Active Customers', String(kpis.active_customers)], [180, 200]);
    w.gap();

    if (kpis.category_mix.length > 0) {
      w.subheading('Category Mix');
      w.row(['Category', 'Revenue'], [200, 200]);
      for (const c of kpis.category_mix) w.row([c.category, `$${c.revenue.toLocaleString()}`], [200, 200]);
    }
  }
  return w.save();
}

async function buildSalesForecast(dataset, columns, rows) {
  const forecast = forecastRevenue(columns, rows, { horizonDays: 30 });
  const w = await newPdfWriter();
  w.heading('Sales Forecast (30 days)');
  w.text(`${dataset.file_name} — generated ${new Date().toISOString()}`);
  w.gap();

  if (!forecast.available) {
    w.text(`Not enough data to forecast — missing: ${forecast.missing.join(', ')}`);
  } else {
    w.text(`Methodology version: ${forecast.methodology_version} (blended linear trend + moving average, §8)`);
    w.gap();
    w.subheading('Projected Revenue by Day');
    w.row(['Date', 'Predicted Revenue'], [140, 200]);
    for (const p of forecast.series) w.row([p.date, `$${p.predicted_revenue.toLocaleString()}`], [140, 200]);
  }
  return w.save();
}

async function buildCustomerSegmentation(dataset, columns, rows) {
  const segmentation = segmentCustomers(columns, rows);
  const w = await newPdfWriter();
  w.heading('Customer Segmentation (RFM)');
  w.text(`${dataset.file_name} — generated ${new Date().toISOString()}`);
  w.gap();

  if (!segmentation.available) {
    w.text(`Not enough data to segment customers — missing: ${segmentation.missing.join(', ')}`);
  } else {
    w.subheading('Segment Summary');
    w.row(['Segment', 'Size', 'Avg Revenue', 'Avg Recency (days)'], [150, 80, 150, 150]);
    for (const s of segmentation.summary_by_label) {
      w.row([s.segment, String(s.size), `$${s.avg_revenue.toLocaleString()}`, String(s.avg_recency)], [150, 80, 150, 150]);
    }
  }
  return w.save();
}

async function buildCleanedDatasetXlsx(dataset, columns, rows) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Cleaned Data');
  const headerNames = columns.map((c) => c.column_name);
  sheet.addRow(headerNames);
  for (const row of rows) {
    sheet.addRow(headerNames.map((h) => row[h]));
  }
  return workbook.xlsx.writeBuffer();
}

const BUILDERS = {
  analytics_summary: { build: buildAnalyticsSummary, extension: '.pdf', mimeType: 'application/pdf' },
  sales_forecast: { build: buildSalesForecast, extension: '.pdf', mimeType: 'application/pdf' },
  customer_segmentation: { build: buildCustomerSegmentation, extension: '.pdf', mimeType: 'application/pdf' },
  cleaned_dataset: {
    build: buildCleanedDatasetXlsx,
    extension: '.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  },
};

export const REPORT_TYPES = Object.keys(BUILDERS);

export async function generateReport(reportType, { dataset, columns, rows }) {
  const builder = BUILDERS[reportType];
  if (!builder) throw new Error(`Unknown report_type: ${reportType}`);
  const bytes = await builder.build(dataset, columns, rows);
  return { buffer: Buffer.from(bytes), extension: builder.extension, mimeType: builder.mimeType };
}
