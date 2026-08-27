let selectedNoteId: string | null = null;

export function setSelectedNoteId(id: string | null): void { selectedNoteId = id; }
export function getSelectedNoteId(): string | null { return selectedNoteId; }
