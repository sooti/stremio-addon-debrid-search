// Simple logging utility that respects LOG_LEVEL environment variable
// LOG_LEVEL values: 'error', 'warn', 'info', 'debug' (default: 'info')

const LOG_LEVELS = {
  error: 0,
  fatal: 0,  // Alias for error
  warn: 1,
  info: 2,
  log: 2,    // Alias for info
  debug: 3
};

const currentLogLevel = process.env.LOG_LEVEL ? process.env.LOG_LEVEL.toLowerCase() : 'info';
const currentLevel = LOG_LEVELS[currentLogLevel] !== undefined ? LOG_LEVELS[currentLogLevel] : LOG_LEVELS.info;

// Save original console methods before overriding
const originalConsole = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  debug: console.debug.bind(console)
};

const logger = {
  error: (...args) => {
    if (currentLevel >= LOG_LEVELS.error) {
      originalConsole.error(...args);
    }
  },
  fatal: (...args) => {
    if (currentLevel >= LOG_LEVELS.fatal) {
      originalConsole.error(...args);
    }
  },
  warn: (...args) => {
    if (currentLevel >= LOG_LEVELS.warn) {
      originalConsole.warn(...args);
    }
  },
  info: (...args) => {
    if (currentLevel >= LOG_LEVELS.info) {
      originalConsole.info(...args);
    }
  },
  log: (...args) => {
    if (currentLevel >= LOG_LEVELS.log) {
      originalConsole.log(...args);
    }
  },
  debug: (...args) => {
    if (currentLevel >= LOG_LEVELS.debug) {
      originalConsole.debug(...args);
    }
  }
};

// For compatibility with existing code that uses console directly
// This can be used to override console globally if needed
export function overrideConsole() {
  console.log = logger.log;
  console.info = logger.info;
  console.warn = logger.warn;
  console.error = logger.error;
  console.debug = logger.debug;
}

export default logger;
