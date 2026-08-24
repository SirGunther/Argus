// Present in the component directory but absent from the manifest. Packaging must refuse it rather
// than silently ship code no declaration accounts for.
export function undeclared() { return 'this file is not declared by the manifest'; }
