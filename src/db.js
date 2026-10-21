'use strict';

/**
 * 見込み客(申込)と診断ログの保存。
 * MySQL(env設定時)を使い、未設定の開発環境ではファイルに保存して動作する。
 */

const fs = require('fs');
const path = require('path');

const hasMysql = !!(process.env.DB_HOST && process.env.DB_NAME && process.env.DB_USER);
let pool = null;

const DATA_DIR = path.join(__dirname, '..', 'data');
const LEADS_FILE = path.join(DATA_DIR, 'leads.json');
const SCANS_FILE = path.join(DATA_DIR, 'scans.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

async function init() {
  if (hasMysql) {
    const mysql = require('mysql2/promise');
    pool = mysql.createPool({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USER,
      password: process.env.DB_PASS || '',
      database: process.env.DB_NAME,
      waitForConnections: true,
      connectionLimit: 5,
      charset: 'utf8mb4',
    });
    await pool.query(`
      CREATE TABLE IF NOT EXISTS webdock_scans (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        domain VARCHAR(255) NOT NULL,
        url TEXT NOT NULL,
        score INT NULL,
        grade VARCHAR(2) NULL,
        result_json LONGTEXT NOT NULL,
        ip VARCHAR(64) NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_domain (domain), INDEX idx_created (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS webdock_leads (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        scan_id BIGINT NULL,
        company VARCHAR(255) NOT NULL,
        contact_name VARCHAR(255) NOT NULL,
        email VARCHAR(255) NOT NULL,
        phone VARCHAR(64) NOT NULL,
        prefecture VARCHAR(16) NULL,
        assigned_company VARCHAR(8) NULL,
        domain VARCHAR(255) NULL,
        source VARCHAR(32) DEFAULT 'webdock',
        ip VARCHAR(64) NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_email (email), INDEX idx_created (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`);
  } else {
    ensureDataDir();
    for (const f of [LEADS_FILE, SCANS_FILE]) if (!fs.existsSync(f)) fs.writeFileSync(f, '[]');
  }
}

function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return []; } }
function writeJson(f, v) { fs.writeFileSync(f, JSON.stringify(v, null, 2)); }

async function saveScan({ domain, url, score, grade, result, ip }) {
  if (hasMysql) {
    const [r] = await pool.query(
      'INSERT INTO webdock_scans (domain,url,score,grade,result_json,ip) VALUES (?,?,?,?,?,?)',
      [domain, url, score, grade, JSON.stringify(result), ip || null]
    );
    return r.insertId;
  }
  ensureDataDir();
  const rows = readJson(SCANS_FILE);
  const id = Date.now();
  rows.push({ id, domain, url, score, grade, result, ip, created_at: new Date().toISOString() });
  writeJson(SCANS_FILE, rows);
  return id;
}

async function getScan(id) {
  if (hasMysql) {
    const [rows] = await pool.query('SELECT * FROM webdock_scans WHERE id=?', [id]);
    if (!rows.length) return null;
    const row = rows[0];
    return { ...row, result: JSON.parse(row.result_json) };
  }
  return readJson(SCANS_FILE).find((s) => String(s.id) === String(id)) || null;
}

async function saveLead(lead) {
  if (hasMysql) {
    const [r] = await pool.query(
      'INSERT INTO webdock_leads (scan_id,company,contact_name,email,phone,prefecture,assigned_company,domain,source,ip) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [lead.scan_id || null, lead.company, lead.contact_name, lead.email, lead.phone, lead.prefecture || null, lead.assigned_company || null, lead.domain || null, lead.source || 'webdock', lead.ip || null]
    );
    return r.insertId;
  }
  ensureDataDir();
  const rows = readJson(LEADS_FILE);
  const id = Date.now();
  rows.push({ id, ...lead, created_at: new Date().toISOString() });
  writeJson(LEADS_FILE, rows);
  return id;
}

module.exports = { init, saveScan, getScan, saveLead, usingMysql: () => hasMysql };
