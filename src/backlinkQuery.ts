export function buildBacklinkQuery(name: string): string {
	const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return " /\\[\\[" + escaped + "(\\|[^\\]]*)?\\]\\]/";
}
