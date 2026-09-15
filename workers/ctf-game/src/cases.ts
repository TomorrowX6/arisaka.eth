import widgets from "./case-catalog.json";
export const cases = widgets.map((widget, index) => ({ id: index + 1, widget }));
export const caseCount = cases.length;
export const catalog = cases.map(({ id }) => ({ id }));
