/**
 * Bottom sheet wrapper — the app's one sheet treatment (docs/design-doc.md
 * §4.5): 24pt top radius, blur backdrop, drag-to-dismiss, title row.
 */
import { BottomSheetBackdrop, BottomSheetModal, BottomSheetScrollView, BottomSheetView, type BottomSheetBackdropProps } from "@gorhom/bottom-sheet";
import { forwardRef, useCallback, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
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
}

export const Sheet = forwardRef<BottomSheetModal, Props>(function Sheet({ title, children, scroll }, ref) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop {...props} appearsOnIndex={0} disappearsOnIndex={-1} opacity={0.45} />
    ),
    [],
  );

  return (
    <BottomSheetModal
      ref={ref}
      enableDynamicSizing
      enablePanDownToClose
      backdropComponent={renderBackdrop}
      backgroundStyle={{ backgroundColor: colors.surface, borderRadius: radius.sheet }}
      handleIndicatorStyle={{ backgroundColor: colors.ink3, width: 36 }}
    >
      {scroll ? (
        <BottomSheetScrollView contentContainerStyle={[styles.content, { paddingBottom: Math.max(insets.bottom, space.lg) }]}>
          <View style={styles.titleRow}>
            <Text role="title">{title}</Text>
          </View>
          {children}
        </BottomSheetScrollView>
      ) : (
        <BottomSheetView style={[styles.content, { paddingBottom: Math.max(insets.bottom, space.lg) }]}>
          <View style={styles.titleRow}>
            <Text role="title">{title}</Text>
          </View>
          {children}
        </BottomSheetView>
      )}
    </BottomSheetModal>
  );
});

const styles = StyleSheet.create({
  content: { paddingHorizontal: space.gutter, gap: space.md },
  titleRow: { paddingTop: space.xs, paddingBottom: space.xs },
});
