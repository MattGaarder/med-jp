import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = path.join(__dirname, '../data/vocab.db');
const jsonDir = path.join(__dirname, '../data/JapaneseExpression/json');

const db = new Database(dbPath);

console.log('Rebuilding grammar tables in vocab.db (relational schema)...');

db.exec(`
  DROP TABLE IF EXISTS grammar;
  DROP TABLE IF EXISTS grammar_anchors;

  CREATE TABLE grammar (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    grammar_id TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    meanings_ja TEXT,
    meanings_en TEXT,
    pattern_raw TEXT,
    alias_of TEXT
  );

  CREATE TABLE grammar_anchors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    grammar_id TEXT NOT NULL,
    anchor_hiragana TEXT NOT NULL,
    priority INTEGER DEFAULT 0
  );

  CREATE INDEX idx_grammar_id ON grammar(grammar_id);
  CREATE INDEX idx_anchor_hira ON grammar_anchors(anchor_hiragana);
  CREATE INDEX idx_anchor_gid ON grammar_anchors(grammar_id);
`);

const insertGrammarStmt = db.prepare(`
  INSERT OR IGNORE INTO grammar 
  (grammar_id, title, meanings_ja, meanings_en, pattern_raw, alias_of)
  VALUES (?, ?, ?, ?, ?, ?)
`);

const insertAnchorStmt = db.prepare(`
  INSERT INTO grammar_anchors 
  (grammar_id, anchor_hiragana, priority)
  VALUES (?, ?, ?)
`);

const files = fs.readdirSync(jsonDir).filter(f => f.endsWith('.json'));

let insertedGrammar = 0;
let insertedAnchors = 0;

// Pass 1: Insert all root grammars and explicit anchors
let aliases = [];

db.transaction(() => {
  for (const file of files) {
    const data = JSON.parse(fs.readFileSync(path.join(jsonDir, file), 'utf-8'));
    
    if (data.alias_of) {
      aliases.push(data);
    } else {
      insertGrammarStmt.run(
        data.id,
        data.title,
        JSON.stringify(data.meanings_ja || []),
        JSON.stringify(data.meanings_en || []),
        data.pattern_raw || '',
        null
      );
      insertedGrammar++;

      if (data.anchors && data.anchors.length > 0) {
        for (const anchor of data.anchors) {
          // Hardcoded priority boosts could go here.
          let priority = 0;
          if (anchor === 'ように') priority = 10;
          
          insertAnchorStmt.run(data.id, anchor, priority);
          insertedAnchors++;
        }
      }
    }
  }

  // Pass 2: Map aliases seamlessly to root targets
  for (const alias of aliases) {
     const targetId = alias.alias_of;
     // The title of the alias page corresponds to the alternative anchor
     // Usually html_parser strips it to something clean like "からいって"
     const anchor = alias.title;
     
     // Point the alternative anchor to the target grammar id
     insertAnchorStmt.run(targetId, anchor, 0);
     insertedAnchors++;
     
     // Optionally keep the alias record in grammar table too
     insertGrammarStmt.run(alias.id, alias.title, null, null, null, targetId);
  }
})();

console.log(`Inserted ${insertedGrammar} grammar roots and ${insertedAnchors} sorted anchors into vocab.db.`);
db.close();
