import { afterEach, describe, expect, it, vi } from 'vitest';
import { saveBlobFileWithDialog } from '../projectFile';

describe('project file saving', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete (window as Window & { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });

  it('falls back to a blob download when the save picker is unavailable', async () => {
    const blob = new Blob(['solid test\nendsolid test\n'], { type: 'model/stl' });
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const createObjectUrlSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mesh');
    const revokeObjectUrlSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const createdElements: Element[] = [];
    const realCreateElement = document.createElement.bind(document);

    vi.spyOn(document, 'createElement').mockImplementation(((tagName: string, options?: ElementCreationOptions) => {
      const element = realCreateElement(tagName, options);
      createdElements.push(element);
      return element;
    }) as typeof document.createElement);

    await saveBlobFileWithDialog('mesh.stl', () => blob);

    const link = createdElements.find((element): element is HTMLAnchorElement => element instanceof HTMLAnchorElement);
    expect(link).toBeDefined();
    expect(link?.download).toBe('mesh.stl');
    expect(link?.href).toBe('blob:mesh');
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(createObjectUrlSpy).toHaveBeenCalledWith(blob);
    expect(revokeObjectUrlSpy).toHaveBeenCalledWith('blob:mesh');
  });
});
