"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import type { Product } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { ImagePlus, Loader2, Package, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/hooks/use-auth";
import { useCan } from "@/hooks/use-can";
import { formatCurrency } from "@/lib/currency";
import {
  MEDIA_MAX_BYTES_BY_KIND,
  uploadAccountMedia,
} from "@/lib/storage/upload-media";
import { useTranslations } from "next-intl";

// ------------------------------------------------------------
// Product catalog (migration 041).
//
// Two readers: the humans keeping it current here, and the AI bot,
// which gains lookup + send-photo tools whenever the account has
// active products (see lib/ai/tools/products.ts).
//
// Data access is the browser Supabase client under RLS, mirroring
// /appointments and /pipelines. Photos upload to the public
// `product-media` bucket through the shared account-scoped helper —
// the URL must stay public because Meta fetches it at send time.
// ------------------------------------------------------------

const PRODUCT_BUCKET = "product-media";

export default function ProductsPage() {
  const t = useTranslations("Products");
  const supabase = createClient();
  const { accountId, user, defaultCurrency } = useAuth();
  const canManage = useCan("edit-settings");

  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);

  // Create / edit dialog. `editing` null = creating.
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Product | null>(null);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [price, setPrice] = useState("");
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const [toDelete, setToDelete] = useState<Product | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from("products")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) {
      console.error("Failed to load products:", error.message);
      return;
    }
    setProducts((data ?? []) as Product[]);
  }, [supabase]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      await load();
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  function openCreate() {
    setEditing(null);
    setName("");
    setDescription("");
    setPrice("");
    setImageUrl(null);
    setOpen(true);
  }

  function openEdit(p: Product) {
    setEditing(p);
    setName(p.name);
    setDescription(p.description ?? "");
    setPrice(p.price != null ? String(p.price) : "");
    setImageUrl(p.image_url ?? null);
    setOpen(true);
  }

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Reset the input so picking the same file twice still fires.
    e.target.value = "";
    if (!file) return;
    if (file.size > MEDIA_MAX_BYTES_BY_KIND.image) {
      toast.error(t("toasts.imageTooLarge"));
      return;
    }
    setUploading(true);
    try {
      const { publicUrl } = await uploadAccountMedia(PRODUCT_BUCKET, file);
      setImageUrl(publicUrl);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("toasts.uploadFailed"));
    } finally {
      setUploading(false);
    }
  }

  async function save() {
    if (!accountId || !name.trim()) return;
    const parsedPrice = price.trim() ? Number(price) : null;
    if (parsedPrice != null && !Number.isFinite(parsedPrice)) {
      toast.error(t("toasts.invalidPrice"));
      return;
    }

    setSaving(true);
    const payload = {
      name: name.trim(),
      description: description.trim() || null,
      price: parsedPrice,
      image_url: imageUrl,
    };
    const { error } = editing
      ? await supabase.from("products").update(payload).eq("id", editing.id)
      : await supabase.from("products").insert({
          account_id: accountId,
          created_by: user?.id ?? null,
          ...payload,
        });
    setSaving(false);
    if (error) {
      toast.error(t("toasts.saveFailed"));
      console.error("Failed to save product:", error.message);
      return;
    }
    toast.success(editing ? t("toasts.updated") : t("toasts.created"));
    setOpen(false);
    load();
  }

  async function toggleActive(p: Product, isActive: boolean) {
    // Optimistic: the switch should feel instant; revert on failure.
    setProducts((prev) =>
      prev.map((x) => (x.id === p.id ? { ...x, is_active: isActive } : x)),
    );
    const { error } = await supabase
      .from("products")
      .update({ is_active: isActive })
      .eq("id", p.id);
    if (error) {
      setProducts((prev) =>
        prev.map((x) => (x.id === p.id ? { ...x, is_active: !isActive } : x)),
      );
      toast.error(t("toasts.saveFailed"));
    }
  }

  async function confirmDelete() {
    if (!toDelete) return;
    const { error } = await supabase
      .from("products")
      .delete()
      .eq("id", toDelete.id);
    if (error) {
      toast.error(t("toasts.deleteFailed"));
      return;
    }
    setToDelete(null);
    toast.success(t("toasts.deleted"));
    load();
  }

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Package className="h-5 w-5 text-primary" />
        <h1 className="text-lg font-semibold">{t("title")}</h1>
        {canManage && (
          <Button size="sm" className="ml-auto" onClick={openCreate}>
            <Plus className="mr-1.5 h-4 w-4" />
            {t("newProduct")}
          </Button>
        )}
      </div>

      <p className="text-sm text-muted-foreground">{t("description")}</p>

      {products.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border py-16 text-center">
          <Package className="h-8 w-8 text-muted-foreground" />
          <p className="text-sm font-medium">{t("emptyTitle")}</p>
          <p className="max-w-sm text-sm text-muted-foreground">
            {t("emptyBody")}
          </p>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {products.map((p) => (
            <div
              key={p.id}
              className="flex flex-col overflow-hidden rounded-lg border border-border bg-card"
            >
              <div className="aspect-video w-full bg-muted">
                {p.image_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={p.image_url}
                    alt={p.name}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <div className="flex h-full items-center justify-center">
                    <ImagePlus className="h-8 w-8 text-muted-foreground" />
                  </div>
                )}
              </div>
              <div className="flex flex-1 flex-col gap-1 p-3">
                <div className="flex items-start justify-between gap-2">
                  <span className="font-medium leading-tight">{p.name}</span>
                  {p.price != null && (
                    <span className="shrink-0 text-sm text-muted-foreground">
                      {formatCurrency(p.price, defaultCurrency)}
                    </span>
                  )}
                </div>
                {p.description && (
                  <p className="line-clamp-2 text-sm text-muted-foreground">
                    {p.description}
                  </p>
                )}
                {canManage && (
                  <div className="mt-auto flex items-center gap-2 pt-2">
                    <Switch
                      checked={p.is_active}
                      onCheckedChange={(v) => toggleActive(p, v)}
                      aria-label={t("active")}
                    />
                    <span className="text-xs text-muted-foreground">
                      {p.is_active ? t("active") : t("inactive")}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="ml-auto h-7 w-7"
                      aria-label={t("edit")}
                      onClick={() => openEdit(p)}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-muted-foreground"
                      aria-label={t("delete")}
                      onClick={() => setToDelete(p)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ---------- Create / edit dialog ---------- */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {editing ? t("editProduct") : t("newProduct")}
            </DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            {/* Photo */}
            <div className="flex flex-col gap-1.5">
              <Label>{t("photo")}</Label>
              <div className="aspect-video w-full overflow-hidden rounded-md border border-border bg-muted">
                {imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={imageUrl}
                    alt={name || t("photo")}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <div className="flex h-full items-center justify-center">
                    <ImagePlus className="h-8 w-8 text-muted-foreground" />
                  </div>
                )}
              </div>
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="hidden"
                onChange={handleFile}
              />
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={uploading}
                  onClick={() => fileRef.current?.click()}
                >
                  {uploading ? (
                    <>
                      <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                      {t("uploading")}
                    </>
                  ) : (
                    <>
                      <ImagePlus className="mr-1.5 h-4 w-4" />
                      {imageUrl ? t("changePhoto") : t("uploadPhoto")}
                    </>
                  )}
                </Button>
                {imageUrl && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground"
                    onClick={() => setImageUrl(null)}
                  >
                    {t("removePhoto")}
                  </Button>
                )}
              </div>
              <p className="text-xs text-muted-foreground">{t("photoHint")}</p>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="prod-name">{t("name")}</Label>
              <Input
                id="prod-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={200}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="prod-price">{t("price")}</Label>
              <Input
                id="prod-price"
                type="number"
                min={0}
                step="0.01"
                placeholder={t("pricePlaceholder")}
                value={price}
                onChange={(e) => setPrice(e.target.value)}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="prod-desc">{t("productDescription")}</Label>
              <Textarea
                id="prod-desc"
                rows={3}
                placeholder={t("descriptionPlaceholder")}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                {t("descriptionHint")}
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              {t("cancel")}
            </Button>
            <Button onClick={save} disabled={!name.trim() || saving || uploading}>
              {saving ? t("saving") : t("save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---------- Delete confirm ---------- */}
      <Dialog
        open={!!toDelete}
        onOpenChange={(o) => !o && setToDelete(null)}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("deleteTitle")}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {t("deleteBody", { name: toDelete?.name ?? "" })}
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setToDelete(null)}>
              {t("cancel")}
            </Button>
            <Button
              className="bg-rose-500 text-white hover:bg-rose-600"
              onClick={confirmDelete}
            >
              {t("delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
