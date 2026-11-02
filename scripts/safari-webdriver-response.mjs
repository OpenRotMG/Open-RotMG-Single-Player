export function safariWebDriverValue(status,data) {
  const value=data.value;
  if(status<200||status>=300||(typeof value?.error==='string'&&typeof value?.message==='string'))throw Error(`Safari WebDriver HTTP${status}: ${JSON.stringify(value)}`);
  return value;
}
