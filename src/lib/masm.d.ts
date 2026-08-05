// Raw-string imports of .masm sources (webpack `asset/source`, see next.config).
declare module "*.masm" {
  const content: string;
  export default content;
}
