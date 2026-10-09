import ts from 'typescript';

/** Inspect syntax tokens, keeping imports and property access but omitting comments. */
export function hasHostDependency(content,file='source.ts') {
 const source=ts.createSourceFile(file,content,ts.ScriptTarget.Latest,true);
 const tokens=[];
 function visit(node){
  if(node.kind>=ts.SyntaxKind.FirstJSDocNode&&node.kind<=ts.SyntaxKind.LastJSDocNode)return;
  const children=node.getChildren(source);if(children.length)children.forEach(visit);else tokens.push(node.getText(source));
 }
 visit(source);
 const code=tokens.join(' ');
 return /@cube\/|\bwindow\s*(?:\.\s*api\b|\[\s*['"]api['"]\s*\])|\bprocess\s*\.\s*env\s*(?:\.\s*(?:CUBE_|CUBED_)|\[\s*['"](?:CUBE_|CUBED_))|(?:ptyd|cubed)\.sock/.test(code);
}
