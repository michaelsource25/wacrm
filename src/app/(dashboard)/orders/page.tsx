"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { createClient } from "@/lib/supabase/client";
import type { Order, OrderStatus } from "@/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { ShoppingCart, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/hooks/use-auth";
import { useCan } from "@/hooks/use-can";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/currency";
import { avatarColorClass, contactInitials } from "@/lib/contacts/avatar";
import { useLocale, useTranslations } from "next-intl";

// ------------------------------------------------------------
// Orders taken over WhatsApp (migration 043).
//
// `pending` is a cart the bot is still building mid-conversation, so
// it is filtered out by default — the owner's working list is what
// customers actually confirmed. Data access is the browser Supabase
// client under RLS, same pattern as /appointments and /products.
// ------------------------------------------------------------

const STATUS_DOT: Record<OrderStatus, string> = {
  pending: "bg-muted-foreground",
  confirmed: "bg-emerald-500",
  delivered: "bg-blue-500",
  cancelled: "bg-rose-500",
};

/** Which status a row can move to next, in the order shown. */
const NEXT_STATUS: Record<OrderStatus, OrderStatus[]> = {
  pending: ["confirmed", "cancelled"],
  confirmed: ["delivered", "cancelled"],
  delivered: [],
  cancelled: [],
};

type Filter = "active" | OrderStatus;

export default function OrdersPage() {
  const t = useTranslations("Orders");
  const locale = useLocale();
  const supabase = createClient();
  const { defaultCurrency } = useAuth();
  const canWrite = useCan("send-messages");

  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>("active");
  const [detail, setDetail] = useState<Order | null>(null);
  const [updating, setUpdating] = useState(false);

  const load = useCallback(async () => {
    let query = supabase
      .from("orders")
      .select(
        "*, contact:contacts(id, name, phone), items:order_items(id, order_id, product_id, product_name, unit_price, quantity, created_at)",
      )
      .order("created_at", { ascending: false })
      .limit(200);

    // "Active" is the default working list: what needs doing. Carts the
    // bot never got confirmed are noise here.
    if (filter === "active") {
      query = query.in("status", ["confirmed", "delivered"]);
    } else {
      query = query.eq("status", filter);
    }

    const { data, error } = await query;
    if (error) {
      console.error("Failed to load orders:", error.message);
      return;
    }
    setOrders((data ?? []) as Order[]);
  }, [supabase, filter]);

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

  async function setStatus(order: Order, status: OrderStatus) {
    setUpdating(true);
    const { error } = await supabase
      .from("orders")
      .update({ status })
      .eq("id", order.id);
    setUpdating(false);
    if (error) {
      toast.error(t("toasts.updateFailed"));
      return;
    }
    toast.success(t("toasts.updated"));
    setDetail(null);
    load();
  }

  async function remove(order: Order) {
    setUpdating(true);
    const { error } = await supabase.from("orders").delete().eq("id", order.id);
    setUpdating(false);
    if (error) {
      toast.error(t("toasts.deleteFailed"));
      return;
    }
    toast.success(t("toasts.deleted"));
    setDetail(null);
    load();
  }

  const dateFmt = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        day: "numeric",
        month: "short",
        hour: "numeric",
        minute: "2-digit",
      }),
    [locale],
  );

  const currencyOf = (o: Order) => o.currency || defaultCurrency;

  const FILTERS: Filter[] = [
    "active",
    "pending",
    "confirmed",
    "delivered",
    "cancelled",
  ];

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
        <ShoppingCart className="h-5 w-5 text-primary" />
        <h1 className="text-lg font-semibold">{t("title")}</h1>
      </div>
      <p className="text-sm text-muted-foreground">{t("description")}</p>

      {/* Status filter */}
      <div className="flex flex-wrap gap-1.5">
        {FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={cn(
              "rounded-full border px-3 py-1 text-xs transition-colors",
              filter === f
                ? "border-primary bg-primary/10 text-primary"
                : "border-border text-muted-foreground hover:bg-muted",
            )}
          >
            {t(`filters.${f}`)}
          </button>
        ))}
      </div>

      {orders.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border py-16 text-center">
          <ShoppingCart className="h-8 w-8 text-muted-foreground" />
          <p className="text-sm font-medium">{t("emptyTitle")}</p>
          <p className="max-w-sm text-sm text-muted-foreground">
            {t("emptyBody")}
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {orders.map((o) => {
            const name = o.contact?.name || o.contact?.phone || t("noContact");
            return (
              <button
                key={o.id}
                type="button"
                onClick={() => setDetail(o)}
                className="flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-3 text-left transition-colors hover:bg-muted/50"
              >
                <div
                  className={cn(
                    "flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-medium text-white",
                    avatarColorClass(o.contact_id),
                  )}
                >
                  {contactInitials(name)}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{name}</span>
                    <span
                      className={cn(
                        "h-2 w-2 shrink-0 rounded-full",
                        STATUS_DOT[o.status],
                      )}
                    />
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {t(`status.${o.status}`)}
                    </span>
                  </div>
                  <span className="block truncate text-xs text-muted-foreground">
                    {t("itemCount", { count: o.items?.length ?? 0 })} ·{" "}
                    {dateFmt.format(new Date(o.created_at))}
                  </span>
                </div>
                <span className="shrink-0 text-sm font-semibold">
                  {formatCurrency(o.total, currencyOf(o))}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* ---------- Detail dialog ---------- */}
      <Dialog open={!!detail} onOpenChange={(open) => !open && setDetail(null)}>
        <DialogContent className="sm:max-w-md">
          {detail && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <span
                    className={cn(
                      "h-2.5 w-2.5 rounded-full",
                      STATUS_DOT[detail.status],
                    )}
                  />
                  {detail.contact?.name ||
                    detail.contact?.phone ||
                    t("noContact")}
                </DialogTitle>
              </DialogHeader>

              <div className="flex flex-col gap-2 text-sm">
                {detail.contact?.phone && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">{t("contact")}</span>
                    <span>{detail.contact.phone}</span>
                  </div>
                )}
                <div className="flex justify-between">
                  <span className="text-muted-foreground">
                    {t("statusLabel")}
                  </span>
                  <span>{t(`status.${detail.status}`)}</span>
                </div>

                <div className="mt-1 flex flex-col gap-1 rounded-md border border-border p-2">
                  {(detail.items ?? []).map((it) => (
                    <div key={it.id} className="flex justify-between gap-2">
                      <span className="min-w-0 truncate">
                        {it.quantity}× {it.product_name}
                      </span>
                      <span className="shrink-0 text-muted-foreground">
                        {formatCurrency(
                          it.unit_price * it.quantity,
                          currencyOf(detail),
                        )}
                      </span>
                    </div>
                  ))}
                  <div className="mt-1 flex justify-between border-t border-border pt-1 font-semibold">
                    <span>{t("total")}</span>
                    <span>
                      {formatCurrency(detail.total, currencyOf(detail))}
                    </span>
                  </div>
                </div>

                {detail.notes && (
                  <div className="rounded-md bg-muted/60 p-2 text-muted-foreground">
                    {detail.notes}
                  </div>
                )}
              </div>

              {canWrite && (
                <DialogFooter className="flex-wrap gap-2 sm:justify-start">
                  {NEXT_STATUS[detail.status].map((next) => (
                    <Button
                      key={next}
                      size="sm"
                      variant={next === "cancelled" ? "outline" : "default"}
                      className={
                        next === "cancelled" ? "text-rose-500" : undefined
                      }
                      disabled={updating}
                      onClick={() => setStatus(detail, next)}
                    >
                      {t(`actions.${next}`)}
                    </Button>
                  ))}
                  <Button
                    size="sm"
                    variant="ghost"
                    className="ml-auto text-muted-foreground"
                    disabled={updating}
                    onClick={() => remove(detail)}
                  >
                    <Trash2 className="mr-1 h-4 w-4" />
                    {t("actions.delete")}
                  </Button>
                </DialogFooter>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
