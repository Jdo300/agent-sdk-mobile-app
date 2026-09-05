/**
 * Bottom sheet wrapper — the app's one sheet treatment (docs/design-doc.md
 * §4.5): 24pt top radius, blur backdrop, drag-to-dismiss, title row.
 */
import { BottomSheetBackdrop, BottomSheetModal, BottomSheetScrollView, BottomSheetView, type BottomSheetBackdropProps } from "@gorhom/bottom-sheet";
import { forwardRef, useCallback, useImperativeHandle, useRef, useState, type ReactNode } from "react";
import { Modal, Platform, Pressable, ScrollView, StyleSheet, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useTheme } from "../../theme/ThemeProvider";
import { radius, space } from "../../theme/tokens";
import { Text } from "./Text";

interface Props {
  title: string;
  children: ReactNode;
  /** Content of unbounded height (tool payloads): dynamic sizing caps at the
   *  screen and the body scrolls with the sheet-aware scrollable. */
  scroll?: boolean;
  /** Tighter treatment for short action menus on phones. */
  compact?: boolean;
}

export const Sheet = forwardRef<BottomSheetModal, Props>(function Sheet({ title, children, scroll, compact }, ref) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const desktopWeb = Platform.OS === "web" && width >= 1000;
  const nativeRef = useRef<BottomSheetModal>(null);
  const [desktopVisible, setDesktopVisible] = useState(false);

  useImperativeHandle(ref, () => ({
    present: () => {
      if (desktopWeb) setDesktopVisible(true);
      else nativeRef.current?.present();
    },
    dismiss: () => {
      if (desktopWeb) setDesktopVisible(false);
      else nativeRef.current?.dismiss();
    },
    close: () => {
      if (desktopWeb) setDesktopVisible(false);
      else nativeRef.current?.close();
    },
    collapse: () => nativeRef.current?.collapse(),
    expand: () => nativeRef.current?.expand(),
    snapToIndex: (index: number, config?: any) => nativeRef.current?.snapToIndex(index, config),
    snapToPosition: (position: any, config?: any) => nativeRef.current?.snapToPosition(position, config),
    forceClose: (config?: any) => {
      if (desktopWeb) setDesktopVisible(false);
      else nativeRef.current?.forceClose(config);
    },
  } as BottomSheetModal), [desktopWeb]);

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop {...props} appearsOnIndex={0} disappearsOnIndex={-1} opacity={0.45} />
    ),
    [],
  );

  const content = (
    <>
      <View style={[styles.titleRow, compact && styles.titleRowCompact]}>
        <Text role={compact ? "bodyEm" : "title"}>{title}</Text>
      </View>
      {children}
    </>
  );

  if (desktopWeb) {
    return (
      <Modal visible={desktopVisible} transparent animationType="fade" onRequestClose={() => setDesktopVisible(false)}>
        <View style={styles.desktopOverlay}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setDesktopVisible(false)} />
          <View style={[styles.desktopDialog, { backgroundColor: colors.surface, borderColor: colors.surfaceEdge }]}>
            {scroll ? (
              <ScrollView contentContainerStyle={[styles.content, compact && styles.contentCompact, { paddingBottom: space.lg }]}>{content}</ScrollView>
            ) : (
              <View style={[styles.content, compact && styles.contentCompact, { paddingBottom: space.lg }]}>{content}</View>
            )}
          </View>
        </View>
      </Modal>
    );
  }

  return (
    <BottomSheetModal
      ref={nativeRef}
      enableDynamicSizing
      enablePanDownToClose
      keyboardBehavior="interactive"
      keyboardBlurBehavior="restore"
      enableBlurKeyboardOnGesture
      backdropComponent={renderBackdrop}
      backgroundStyle={{ backgroundColor: colors.surface, borderRadius: radius.sheet }}
      handleIndicatorStyle={{ backgroundColor: colors.ink3, width: 36 }}
    >
      {scroll ? (
        <BottomSheetScrollView contentContainerStyle={[styles.content, compact && styles.contentCompact, { paddingBottom: Math.max(insets.bottom, compact ? space.md : space.lg) }]}>{content}</BottomSheetScrollView>
      ) : (
        <BottomSheetView style={[styles.content, compact && styles.contentCompact, { paddingBottom: Math.max(insets.bottom, compact ? space.md : space.lg) }]}>{content}</BottomSheetView>
      )}
    </BottomSheetModal>
  );
});

const styles = StyleSheet.create({
  desktopOverlay: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(0,0,0,0.38)", padding: 24 },
  desktopDialog: { width: "100%", maxWidth: 720, maxHeight: "82%", borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.sheet, shadowColor: "#000", shadowOpacity: 0.22, shadowRadius: 28, shadowOffset: { width: 0, height: 12 }, overflow: "hidden" },
  content: { paddingHorizontal: space.gutter, gap: space.md },
  contentCompact: { gap: 4, paddingHorizontal: 20 },
  titleRow: { paddingTop: space.xs, paddingBottom: space.xs },
  titleRowCompact: { paddingTop: 0, paddingBottom: 4 },
});
