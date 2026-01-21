/**
 * @file BRI example helpers for console output formatting
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
 * Print the kitchen sink banner
 * @returns {void}
 */
export const printBanner = () => {
  console.log('+' + '='.repeat(68) + '+');
  console.log('|' + ' '.repeat(15) + 'BRI KITCHEN SINK EXAMPLES' + ' '.repeat(28) + '|');
  console.log('|' + ' '.repeat(10) + 'Every Client Function Demonstrated' + ' '.repeat(24) + '|');
  console.log('+' + '='.repeat(68) + '+');
};

/**
 * Print the completion banner
 * @returns {void}
 */
export const printComplete = () => {
  console.log('\n+' + '='.repeat(68) + '+');
  console.log('|' + ' '.repeat(20) + 'KITCHEN SINK COMPLETE!' + ' '.repeat(26) + '|');
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
