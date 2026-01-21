/**
 * @file BRI remote example helpers for console output formatting
 */

/**
 * Print a numbered section header
 * @param {number} num - Section number
 * @param {string} title - Section title
 * @returns {void}
 */
export const section = (num, title) => {
  console.log('\n' + '='.repeat(70));
  console.log(`  EXAMPLE ${num}: ${title}`);
  console.log('='.repeat(70));
};

/**
 * Print a subsection header
 * @param {string} title - Subsection title
 * @returns {void}
 */
export const subsection = (title) => {
  console.log('\n  > ' + title);
  console.log('  ' + '-'.repeat(66));
};

/**
 * Print the remote client banner
 * @returns {void}
 */
export const printBanner = () => {
  console.log('+' + '='.repeat(68) + '+');
  console.log('|' + ' '.repeat(12) + 'BRI REMOTE CLIENT EXAMPLES' + ' '.repeat(30) + '|');
  console.log('|' + ' '.repeat(10) + 'Every Client Function via WebSocket' + ' '.repeat(23) + '|');
  console.log('+' + '='.repeat(68) + '+');
};

/**
 * Print the completion banner
 * @returns {void}
 */
export const printComplete = () => {
  console.log('\n+' + '='.repeat(68) + '+');
  console.log('|' + ' '.repeat(18) + 'REMOTE CLIENT COMPLETE!' + ' '.repeat(27) + '|');
  console.log('+' + '='.repeat(68) + '+\n');
};

/**
 * Print cleanup section header
 * @returns {void}
 */
export const printCleanup = () => {
  console.log('\n' + '='.repeat(70));
  console.log('  CLEANUP');
  console.log('='.repeat(70));
};
