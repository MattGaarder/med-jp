import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import util from 'node:util';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Default log file destination (placed in project root for easy access)
const DEFAULT_LOG_PATH = path.resolve(__dirname, '../pipeline.log');

/**
 * Appends a formatted section header and pretty-printed data to the log file.
 * 
 * @param {string} title - The title of the section.
 * @param {*} data - The data to print (string, object, array, or undefined).
 * @param {Object} [options] - Optional configurations.
 * @param {string} [options.logPath] - Custom path to log file.
 */
export function logSection(title, data, options = {}) {
  const logPath = options.logPath || DEFAULT_LOG_PATH;

  // QoL: Ensure the target directory exists
  const logDir = path.dirname(logPath);
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  const timestamp = new Date().toISOString();
  const border = '='.repeat(50);
  
  let formattedData = '';
  if (data !== undefined) {
    if (typeof data === 'string') {
      formattedData = data;
    } else {
      formattedData = util.inspect(data, {
        depth: null,
        colors: false,
        maxArrayLength: null,
        compact: false,
        breakLength: 80
      });
    }
  }

  const logEntry = `${border}\n[${timestamp}] ${title.toUpperCase()}\n${border}\n${formattedData}\n\n`;

  try {
    fs.appendFileSync(logPath, logEntry, 'utf8');
    console.log(logEntry);
  } catch (err) {
    // Avoid console.error to prevent recursion during intercept
  }
}

/**
 * QoL Helper: Intercepts all standard console.log output globally.
 * Color/style escape codes are stripped automatically so the log file is clean text.
 * 
 * @param {string} [logPath] - Custom path to log file.
 */
export function enableGlobalIntercept(logPath = DEFAULT_LOG_PATH) {
  const originalLog = console.log;
  console.log = (...args) => {
    originalLog(...args); // Keep terminal printing intact

    const rawMsg = util.format(...args);
    // Strip ANSI terminal color/formatting codes
    const cleanMsg = rawMsg.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');

    try {
      fs.appendFileSync(logPath, cleanMsg + '\n', 'utf8');
    } catch (err) {
      // Fail silently to prevent infinite print loops
    }
  };
}

/**
 * QoL Helper: Clears the log file (truncates it to 0 bytes).
 * Useful at the start of a new debugging run.
 * 
 * @param {string} [logPath] - Custom path to log file.
 */
export function clearLogs(logPath = DEFAULT_LOG_PATH) {
  try {
    if (fs.existsSync(logPath)) {
      fs.writeFileSync(logPath, '', 'utf8');
    }
  } catch (err) {
    // Fail silently
  }
}
