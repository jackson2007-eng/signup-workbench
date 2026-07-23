// Single switch for the whole app's dark/light toggle. Off for now — with several tools mounted
// at once in the Shell, each module's independent theme state caused visible mismatches when
// switching tabs (a tool left in "light" could inherit a sibling's dark colors). Flip back to
// true once theme state is properly shared (e.g. lifted to Shell) rather than per-module.
export const DARK_MODE_ENABLED = false;
