/**
 * ============================================================================
 * BLOB URL REGISTRY & MEMORY LIFECYCLE MANAGER
 * ============================================================================
 * Управляет временем жизни Blob / ObjectURL ссылок в браузере,
 * обеспечивая 100% авто-очистку памяти при смене треков,
 * удалении A/B превью и размонтировании UI компонентов.
 */

export class BlobUrlRegistry {
  private static urls = new Set<string>();

  /**
   * Создает ObjectURL для Blob и автоматически регистрирует его в реестре
   */
  public static create(blob: Blob): string {
    const url = URL.createObjectURL(blob);
    this.urls.add(url);
    return url;
  }

  /**
   * Принудительно отзывает конкретный ObjectURL и удаляет из реестра
   */
  public static revoke(url: string | null | undefined): void {
    if (!url) return;
    if (this.urls.has(url)) {
      try {
        URL.revokeObjectURL(url);
      } catch (_) {}
      this.urls.delete(url);
    } else if (url.startsWith('blob:')) {
      try {
        URL.revokeObjectURL(url);
      } catch (_) {}
    }
  }

  /**
   * Пакетный отзыв указанного массива или всех зарегистрированных Blob URL
   */
  public static revokeAll(urls?: (string | null | undefined)[]): void {
    if (urls) {
      for (const u of urls) {
        this.revoke(u);
      }
    } else {
      for (const u of this.urls) {
        try {
          URL.revokeObjectURL(u);
        } catch (_) {}
      }
      this.urls.clear();
    }
  }

  /**
   * Возвращает текущее количество активных зарегистрированных ObjectURL
   */
  public static count(): number {
    return this.urls.size;
  }
}
