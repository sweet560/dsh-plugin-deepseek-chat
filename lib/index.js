/**
 * Host half of dsh-plugin-deepseek-chat.
 *
 * The feature is browser-surface only: the right Sidebar guide card and the
 * redirect into the built-in Browser tab both live in ./client.js. This half
 * exists because the package is mounted as an ordinary Loader entry, and a
 * client bundle is discovered through its entry.
 */
export function apply() {}
