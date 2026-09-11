// The explicit package path avoids Node's builtin and never installs a global Buffer.
import { Buffer } from "buffer/index.js";

export { Buffer };
export default { Buffer };
